#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");

const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");
const CLAUDE_3P_LOCAL_SESSIONS = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude-3p",
  "local-agent-mode-sessions"
);

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

function walk(dir, files) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath, files);
    else if (entry.name.endsWith(".jsonl")) files.push(fullPath);
  }
}

function walkAuditLogs(dir, files) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walkAuditLogs(fullPath, files);
    else if (entry.name === "audit.jsonl") files.push(fullPath);
  }
}

function usageFromEvent(event) {
  const usage = event.message?.usage || event.usage || event.providerData?.rawUsage;
  if (!usage) return null;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0);
  const cacheRead = Number(
    usage.cache_read_input_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? usage.cacheReadInputTokens
      ?? 0
  );
  const cacheWrite = Number(
    usage.cache_creation_input_tokens
      ?? usage.prompt_cache_write_tokens
      ?? usage.cacheCreationInputTokens
      ?? 0
  );
  if (input + output + cacheRead + cacheWrite <= 0) return null;
  return { input, output, cache_read: cacheRead, cache_write: cacheWrite };
}

function usagesFromAuditEvent(event) {
  if (event.modelUsage && typeof event.modelUsage === "object") {
    return Object.entries(event.modelUsage)
      .map(([model, usage]) => ({
        model,
        usage: {
          input: Number(usage.inputTokens ?? usage.input_tokens ?? 0),
          output: Number(usage.outputTokens ?? usage.output_tokens ?? 0),
          cache_read: Number(usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? 0),
          cache_write: Number(usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? 0),
        },
      }))
      .filter(({ usage }) => usage.input + usage.output + usage.cache_read + usage.cache_write > 0);
  }

  const usage = usageFromEvent(event);
  if (!usage) return [];
  return [{ model: event.message?.model || event.model || "unknown", usage }];
}

function resolveAuditUsageModels(event, observedAssistantModels) {
  const usageItems = usagesFromAuditEvent(event);
  if (
    event.modelUsage
    && usageItems.length === 1
    && observedAssistantModels.size === 1
  ) {
    const [actualModel] = observedAssistantModels;
    return [{ ...usageItems[0], model: actualModel }];
  }
  return usageItems;
}

function addUsage(aggregated, date, model, usage) {
  const key = `${date}|claude-code|${model}`;
  if (!aggregated[key]) {
    aggregated[key] = {
      date,
      tool: "claude-code",
      model,
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    };
  }
  aggregated[key].input += usage.input;
  aggregated[key].output += usage.output;
  aggregated[key].cache_read += usage.cache_read;
  aggregated[key].cache_write += usage.cache_write;
}

function main() {
  const files = [];
  walk(CLAUDE_PROJECTS, files);

  const seen = new Set();
  const aggregated = {};
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const usage = usageFromEvent(event);
        if (!usage) continue;
        const eventId = event.uuid || event.message?.id || event.id || `${file}:${line.length}:${event.timestamp || ""}`;
        if (seen.has(eventId)) continue;
        seen.add(eventId);
        const date = localDateFromTimestamp(event.timestamp || event.created_at || event.message?.created_at);
        if (!date) continue;
        const model = event.message?.model || event.model || event.providerData?.model || "unknown";
        addUsage(aggregated, date, model, usage);
      } catch {}
    }
  }

  const auditFiles = [];
  walkAuditLogs(CLAUDE_3P_LOCAL_SESSIONS, auditFiles);
  for (const file of auditFiles) {
    const observedAssistantModels = new Set();
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "assistant") {
          const actualModel = event.message?.model || event.model || event.providerData?.model;
          if (actualModel) observedAssistantModels.add(actualModel);
        }
        const date = localDateFromTimestamp(event.timestamp || event.created_at || event._audit_timestamp);
        if (!date) continue;
        const usageItems = resolveAuditUsageModels(event, observedAssistantModels);
        if (usageItems.length === 0) continue;
        const eventId = `audit:${file}:${event.uuid || event.message?.id || event.id || event.timestamp || line.length}`;
        if (seen.has(eventId)) continue;
        seen.add(eventId);
        for (const { model, usage } of usageItems) {
          addUsage(aggregated, date, model, usage);
        }
        if (event.modelUsage) observedAssistantModels.clear();
      } catch {}
    }
  }

  return Object.values(aggregated)
    .map((row) => ({ ...row, normalized: row.input + row.output }))
    .sort((a, b) => (a.date + a.tool + a.model).localeCompare(b.date + b.tool + b.model));
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(main(), null, 2));
}

module.exports = { main, resolveAuditUsageModels };
