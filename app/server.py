#!/usr/bin/env python3
import json
import os
import socket
import subprocess
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
START_PORT = int(os.environ.get("PORT", "3899"))
REFRESH_SECONDS = 300
OPENTOKEN = Path.home() / ".local/bin/opentoken"
APP_DIR = Path(__file__).resolve().parent
ALLOWED_TOOLS = {"codex", "claude-code", "hermes", "cursor", "copilot-cli"}

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


def refresh():
    global cache
    with lock:
        if cache.get("refreshing"):
            return
        cache = {**cache, "refreshing": True, "error": None}

    started_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    try:
        output = subprocess.check_output(
            [str(OPENTOKEN), "preview", "--json"],
            stderr=subprocess.STDOUT,
            timeout=240,
        )
        payload = json.loads(output.decode("utf-8") or "[]")
        raw_rows = payload if isinstance(payload, list) else payload.get("rows", [])
        rows = []
        for raw_row in raw_rows:
            row = normalize_row(raw_row)
            if row["date"] and row["tool"] in ALLOWED_TOOLS:
                rows.append(row)
        rows.sort(key=lambda item: (item["date"], item["tool"], item["model"]), reverse=True)
        cache = {
            "ok": True,
            "refreshing": False,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "error": None,
            "rows": rows,
            "sources": {"startedAt": started_at, "opentokenRows": len(raw_rows)},
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


if __name__ == "__main__":
    threading.Thread(target=refresh_loop, daemon=True).start()
    port = free_port(START_PORT)
    url = f"http://{HOST}:{port}/"
    print(f"本地 Token 看板: {url}", flush=True)
    webbrowser.open(url)
    ThreadingHTTPServer((HOST, port), Handler).serve_forever()
