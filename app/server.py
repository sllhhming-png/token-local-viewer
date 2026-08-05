#!/usr/bin/env python3
import json
import os
import shutil
import signal
import socket
import subprocess
import threading
import time
import webbrowser
from glob import glob
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
START_PORT = int(os.environ.get("PORT", "3899"))
REFRESH_SECONDS = 300
OPENTOKEN = Path.home() / ".local/bin/opentoken"
APP_DIR = Path(__file__).resolve().parent
ALLOWED_TOOLS = {"codex", "claude-code", "hermes", "cursor", "copilot-cli"}
PID_FILE = Path("/tmp/token-local-viewer.pid")
URL_FILE = Path("/tmp/token-local-viewer.url")

cache = {
    "ok": False,
    "refreshing": False,
    "updatedAt": None,
    "error": None,
    "rows": [],
    "sources": {},
}
lock = threading.Lock()


def clean_tool(value):
    return str(value or "").strip().lower()


def normalize_row(row):
    input_tokens = int(row.get("input") or 0)
    output_tokens = int(row.get("output") or 0)
    cache_read = int(row.get("cache_read") or row.get("cacheRead") or 0)
    cache_write = int(row.get("cache_write") or row.get("cacheWrite") or 0)
    normalized = input_tokens + output_tokens
    return {
        "date": row.get("date"),
        "tool": clean_tool(row.get("tool")),
        "model": str(row.get("model") or "unknown"),
        "input": input_tokens,
        "output": output_tokens,
        "cache_read": cache_read,
        "cache_write": cache_write,
        "normalized": normalized,
        "total_with_cache": normalized + cache_read + cache_write,
    }


def run_json_command(command, timeout=240):
    output = subprocess.check_output(command, stderr=subprocess.STDOUT, timeout=timeout)
    payload = json.loads(output.decode("utf-8") or "[]")
    return payload if isinstance(payload, list) else payload.get("rows", [])


def run_opentoken_preview():
    return run_json_command([str(OPENTOKEN), "preview", "--json"])


def find_node():
    candidates = [
        shutil.which("node"),
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        str(Path.home() / ".local/bin/node"),
    ]
    candidates.extend(glob(str(Path.home() / ".nvm/versions/node/*/bin/node")))
    candidates.extend(glob(str(Path.home() / ".volta/bin/node")))
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    return None


def run_node_scanner(script_name):
    script = APP_DIR / script_name
    node = find_node()
    if not node or not script.exists():
        return []
    return run_json_command([node, str(script)])


def merge_rows(official_rows, codex_rows, claude_rows):
    merged = {}
    has_codex_scan = len(codex_rows) > 0

    def put_best(row):
        key = f"{row['date']}|{row['tool']}|{row['model']}"
        previous = merged.get(key)
        if not previous or row["total_with_cache"] > previous["total_with_cache"]:
            merged[key] = row

    for raw_row in official_rows:
        row = normalize_row(raw_row)
        if not row["date"] or row["tool"] not in ALLOWED_TOOLS:
            continue
        if has_codex_scan and row["tool"] == "codex":
            continue
        put_best(row)

    for raw_row in [*codex_rows, *claude_rows]:
        row = normalize_row(raw_row)
        if not row["date"] or row["tool"] not in ALLOWED_TOOLS:
            continue
        put_best(row)

    return sorted(
        merged.values(),
        key=lambda item: (item["date"], item["tool"], item["model"]),
        reverse=True,
    )


def refresh():
    global cache
    with lock:
        if cache.get("refreshing"):
            return
        cache = {**cache, "refreshing": True, "error": None}

    started_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    try:
        official_rows = run_opentoken_preview()
        node_path = find_node()
        codex_rows = run_node_scanner("accurate-scan.js")
        claude_rows = run_node_scanner("claude-scan.js")
        rows = merge_rows(official_rows, codex_rows, claude_rows)
        cache = {
            "ok": True,
            "refreshing": False,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "error": None,
            "rows": rows,
            "sources": {
                "startedAt": started_at,
                "opentokenRows": len(official_rows),
                "codexRows": len(codex_rows),
                "claudeRows": len(claude_rows),
                "node": node_path,
            },
        }
    except Exception as error:
        cache = {
            "ok": False,
            "refreshing": False,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "error": str(error),
            "rows": cache.get("rows", []),
            "sources": {"startedAt": started_at},
        }


def refresh_loop():
    while True:
        refresh()
        time.sleep(REFRESH_SECONDS)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send_body(self, code, body, content_type):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/usage"):
            if "refresh=1" in self.path:
                threading.Thread(target=refresh, daemon=True).start()
            body = json.dumps(cache, ensure_ascii=False).encode("utf-8")
            self.send_body(200, body, "application/json; charset=utf-8")
            return

        html_path = APP_DIR / "index.html"
        self.send_body(200, html_path.read_bytes(), "text/html; charset=utf-8")

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()


def free_port(start):
    for port in range(start, start + 30):
        with socket.socket() as sock:
            try:
                sock.bind((HOST, port))
                return port
            except OSError:
                continue
    raise SystemExit("找不到可用端口")


def process_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def use_existing_viewer():
    try:
        pid = int(PID_FILE.read_text().strip())
        url = URL_FILE.read_text().strip()
    except Exception:
        return False
    if not url or not process_alive(pid):
        return False
    print(f"本地 Token 看板: {url}", flush=True)
    webbrowser.open(url)
    return True


def write_runtime_files(url):
    PID_FILE.write_text(str(os.getpid()))
    URL_FILE.write_text(url)


def cleanup_runtime_files(*_args):
    for file_path in (PID_FILE, URL_FILE):
        try:
            if file_path.exists():
                file_path.unlink()
        except OSError:
            pass
    raise SystemExit(0)


if __name__ == "__main__":
    if use_existing_viewer():
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, cleanup_runtime_files)
    signal.signal(signal.SIGINT, cleanup_runtime_files)
    threading.Thread(target=refresh_loop, daemon=True).start()
    port = free_port(START_PORT)
    url = f"http://{HOST}:{port}/"
    write_runtime_files(url)
    print(f"本地 Token 看板: {url}", flush=True)
    webbrowser.open(url)
    ThreadingHTTPServer((HOST, port), Handler).serve_forever()
