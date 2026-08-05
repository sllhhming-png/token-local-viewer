#!/usr/bin/env node
// 准确扫描 Codex session 文件，提取真实 token 用量
const fs = require("fs");
const path = require("path");
const os = require("os");

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

function codexHomes() {
  const homes = [CODEX_HOME];
  const instancesDir = path.join(os.homedir(), ".antigravity_cockpit", "instances", "codex");
  if (fs.existsSync(instancesDir)) {
    for (const entry of fs.readdirSync(instancesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const home = path.join(instancesDir, entry.name);
      if (fs.existsSync(path.join(home, "sessions")) || fs.existsSync(path.join(home, "archived_sessions"))) {
        homes.push(home);
      }
    }
  }
  return [...new Set(homes)];
}

function usageToRow(usage) {
  if (!usage) return null;
  // Keep the same public TokenRank/SCYS display semantics as the original
  // uploader: input_tokens is uploaded as input, and cached_input_tokens is
  // uploaded separately as cache_read. The SCYS page displays input + output
  // + cache, so changing this to subtract cache would make historical totals
  // appear to shrink compared with the user's previous screenshots.
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cache_read: usage.cached_input_tokens || 0,
    cache_write: 0,
  };
}

function usageDelta(current, previous) {
  if (!current) return null;
  if (!previous) return current;
  return {
    input_tokens: Math.max(0, (current.input_tokens || 0) - (previous.input_tokens || 0)),
    cached_input_tokens: Math.max(0, (current.cached_input_tokens || 0) - (previous.cached_input_tokens || 0)),
    output_tokens: Math.max(0, (current.output_tokens || 0) - (previous.output_tokens || 0)),
  };
}

function localDateFromTimestamp(ts) {
  if (!ts) return null;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function scanJsonl(filePath) {
  let lines;
  try {
    lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  } catch (e) {
    return [];
  }

  let model = null;
  let previousTotalUsage = null;
  const rows = [];

  for (const line of lines) {
    try {
      const j = JSON.parse(line);
      // 提取 model
      if (j.type === "turn_context" && j.payload?.model) {
        model = j.payload.model;
      }
      if (j.type === "session_meta" && j.payload?.model_provider) {
        // session_meta 不含具体 model 名
      }
      if (j.type === "event_msg" && j.payload?.type === "token_count") {
        const totalUsage = j.payload.info?.total_token_usage || null;
        const usage = usageDelta(totalUsage, previousTotalUsage);
        const date = localDateFromTimestamp(j.timestamp);
        const usageRow = usageToRow(usage);
        previousTotalUsage = totalUsage || previousTotalUsage;
        if (date && usageRow) {
          rows.push({
            date,
            model: model || "unknown",
            ...usageRow,
          });
        }
      }
    } catch (e) {}
  }

  return rows;
}

function getDateFromTimestamp(ts) {
  if (!ts) return null;
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch (e) {
    return null;
  }
}

function getDateFromFilename(filename) {
  // rollout-2026-06-24T10-43-49-...
  const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function walkDir(dir, files) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, files);
    } else if (entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
}

function isFormalSessionPath(filePath) {
  return /\/(sessions|archived_sessions)\//.test(filePath)
    && !/backup|\.bak|sessions\.backup/.test(filePath);
}

function sessionFiles() {
  const candidates = [];
  for (const home of codexHomes()) {
    // Walk the whole Codex home: normal sessions are authoritative, while
    // backup-only rollout files can contain real historical usage that is no
    // longer present in sessions/archived_sessions. Dedupe by rollout name.
    walkDir(home, candidates);
  }

  // The same rollout can exist in multiple Codex homes after migrations or
  // visibility repair. Count each rollout once and keep the fullest copy.
  const byRollout = new Map();
  for (const filePath of candidates) {
    const name = path.basename(filePath).replace(/\.bak$/, "");
    if (!name.startsWith("rollout-")) continue;
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    const formal = isFormalSessionPath(filePath);
    const previous = byRollout.get(name);
    if (
      !previous
      || (formal && !previous.formal)
      || (formal === previous.formal && (stat.size > previous.size || (stat.size === previous.size && stat.mtimeMs > previous.mtimeMs)))
    ) {
      byRollout.set(name, { filePath, formal, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return [...byRollout.values()].map((item) => item.filePath);
}

function main() {
  const results = [];

  for (const filePath of sessionFiles()) {
    results.push(...scanJsonl(filePath));
  }

  // 按 (date, model) 聚合
  const aggregated = {};
  for (const r of results) {
    const key = `${r.date}|${r.model}`;
    if (!aggregated[key]) {
      aggregated[key] = {
        date: r.date,
        tool: "codex",
        model: r.model,
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
      };
    }
    aggregated[key].input += r.input;
    aggregated[key].output += r.output;
    aggregated[key].cache_read += r.cache_read;
    aggregated[key].cache_write += r.cache_write;
  }

  // 计算 normalized (input + output，不含 cache_read)
  const rows = Object.values(aggregated).map((r) => ({
    ...r,
    normalized: r.input + r.output,
  }));

  rows.sort((a, b) => a.date.localeCompare(b.date));

  return rows;
}

// 如果直接运行，输出 JSON
if (require.main === module) {
  const rows = main();
  // 输出到 stdout
  process.stdout.write(JSON.stringify(rows, null, 2));
}

module.exports = { main };
