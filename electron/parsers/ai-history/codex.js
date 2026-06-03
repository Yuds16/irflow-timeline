/**
 * parsers/ai-history/codex.js — OpenAI Codex CLI / Desktop local artifacts (~/.codex).
 *
 * Artifacts:
 *   ~/.codex/history.jsonl — { session_id, ts, text }
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — session transcripts
 *   ~/.codex/archived_sessions/.../rollout-*.jsonl — archived threads
 *   ~/.codex/session_index.jsonl — thread id / title index (optional metadata)
 *
 * Desktop app state lives under ~/.codex (not Application Support/Codex, which is UI cache).
 */

const fs = require("fs");
const path = require("path");
const { readJsonlBounded } = require("./jsonl-reader");
const os = require("os");

const { dbg } = require("../../logger");
const { shouldSkipSubagentPath, filterSidechainRows, tickFileProgress } = require("./extract-plan");
const { TOOL_CODEX } = require("./schema");
const {
  formatTimestampUtc,
  parseIsoTimestamp,
  makeRow,
  assignLineNumber,
  finalizeAiHistoryRows,
  truncateSummary,
} = require("./row-utils");

const CODEX_DIR_NAME = ".codex";
const ROLLOUT_FILE_RE = /^rollout-.+\.jsonl$/i;

function codexRow(fields) {
  return makeRow({ ...fields, tool: fields.tool || TOOL_CODEX }, TOOL_CODEX);
}

/** Forked / child Codex threads (parent session id or explicit subagent flag). */
function isCodexForkedSession(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.is_subagent === true || payload.subagent === true || payload.is_fork === true) return true;
  const parent = payload.parent_session_id ?? payload.parentSessionId
    ?? payload.forked_from ?? payload.forked_from_session_id ?? payload.parent_id;
  return parent != null && String(parent).trim() !== "";
}

function resolveCodexHome(target) {
  if (process.env.CODEX_HOME) {
    const envHome = path.resolve(process.env.CODEX_HOME);
    if (fs.existsSync(envHome) && isCodexDir(envHome)) return envHome;
  }

  if (!target) return null;
  let p = target;
  try {
    if (fs.statSync(p).isFile()) p = path.dirname(p);
  } catch { return null; }

  for (let i = 0; i < 16; i++) {
    if (path.basename(p) === CODEX_DIR_NAME && isCodexDir(p)) return p;
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  if (isCodexDir(target)) return path.resolve(target);
  return null;
}

function peekHistoryJsonl(histPath) {
  try {
    const fd = fs.openSync(histPath, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const line = buf.slice(0, n).toString("utf8").split("\n").find((l) => l.trim());
    if (!line) return null;
    const o = JSON.parse(line);
    if (o && o.session_id != null && o.ts != null && o.text != null) return o;
  } catch { /* ignore */ }
  return null;
}

function isCodexDir(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return false;
  if (path.basename(dirPath) !== CODEX_DIR_NAME) return false;
  try {
    if (!fs.statSync(dirPath).isDirectory()) return false;
  } catch { return false; }

  if (fs.existsSync(path.join(dirPath, "sessions"))) return true;
  if (fs.existsSync(path.join(dirPath, "archived_sessions"))) return true;

  const hist = path.join(dirPath, "history.jsonl");
  if (fs.existsSync(hist) && peekHistoryJsonl(hist)) return true;

  return listRolloutFiles(dirPath).length > 0;
}

function isCodexRolloutFile(filePath) {
  if (!filePath || path.extname(filePath).toLowerCase() !== ".jsonl") return false;
  if (!ROLLOUT_FILE_RE.test(path.basename(filePath))) return false;
  return filePath.includes(`${path.sep}${CODEX_DIR_NAME}${path.sep}`);
}

function listRolloutFiles(codexRoot, options = {}) {
  const out = [];
  for (const sub of ["sessions", "archived_sessions"]) {
    const base = path.join(codexRoot, sub);
    if (!fs.existsSync(base)) continue;
    const stack = [base];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (shouldSkipSubagentPath(full, options)) continue;
          if (!e.isSymbolicLink()) stack.push(full);
        } else if (e.isFile() && ROLLOUT_FILE_RE.test(e.name)) {
          if (!shouldSkipSubagentPath(full, options)) out.push(full);
        }
      }
    }
  }
  return out;
}

function countRolloutFiles(codexRoot) {
  return listRolloutFiles(codexRoot).length;
}

/** Strip IDE wrapper / environment blocks from Codex user prompts. */
function stripCodexUserText(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  const req = s.match(/##\s*My request for Codex:\s*([\s\S]*)/i);
  if (req) return req[1].trim();
  if (/<environment_context>/i.test(s)) return "";
  return s;
}

function extractPayloadContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts = [];
  let hasReasoning = false;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const type = item.type || "";
    if (type === "input_text" || type === "output_text" || type === "text") {
      const t = item.text != null ? String(item.text) : "";
      const cleaned = stripCodexUserText(t);
      if (cleaned) parts.push(cleaned);
    } else if (type === "tool_use" || type === "function_call") {
      const name = item.name || item.function?.name || "tool";
      parts.push(`[Tool: ${name}]`);
    } else if (type === "tool_result" || type === "function_call_output") {
      parts.push("[Tool Result]");
    } else if (type === "thinking" || type === "reasoning") {
      hasReasoning = true;
    }
  }
  let text = parts.join(" ").trim();
  if (hasReasoning && !/\[Reasoning present\]/.test(text)) {
    text = text ? `${text} [Reasoning present]` : "[Reasoning present]";
  }
  return text;
}

function loadThreadIndex(codexRoot) {
  const map = new Map();
  const idxPath = path.join(codexRoot, "session_index.jsonl");
  if (!fs.existsSync(idxPath)) return map;
  try {
    for (const line of fs.readFileSync(idxPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o?.id) {
        map.set(String(o.id), {
          threadName: o.thread_name != null ? String(o.thread_name) : "",
          updatedAt: o.updated_at != null ? String(o.updated_at) : "",
        });
      }
    }
  } catch (e) {
    dbg("AIHIST", "codex session_index read failed", { err: e.message });
  }
  return map;
}

/** Parse ~/.codex/history.jsonl line. */
function parseCodexHistoryLine(obj, sourceFile, attribution = {}) {
  const summary = obj.text != null ? String(obj.text).trim() : "";
  if (!summary) return null;

  const tsRaw = obj.ts;
  const tsMs = typeof tsRaw === "number" ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000) : parseInt(tsRaw, 10);
  if (!Number.isFinite(tsMs) || tsMs <= 0) return null;

  return codexRow({
    timestamp: formatTimestampUtc(tsMs),
    role: "user",
    recordType: "history",
    summary,
    sessionId: obj.session_id != null ? String(obj.session_id) : "",
    messageId: "",
    parentId: "",
    workspace: "",
    toolName: "",
    isSidechain: false,
    gitBranch: "",
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    sourceFile,
    user: attribution.user || "",
    host: attribution.host || "",
  });
}

function parseRolloutEnvelope(obj, sourceFile, ctx, attribution) {
  const recordType = obj.type != null ? String(obj.type) : "unknown";
  const tsMs = parseIsoTimestamp(obj.timestamp);
  if (tsMs == null) return null;

  const payload = obj.payload && typeof obj.payload === "object" ? obj.payload : {};

  if (recordType === "session_meta") {
    ctx.sessionId = payload.id != null ? String(payload.id) : ctx.sessionId;
    ctx.isSidechainSession = isCodexForkedSession(payload);
    ctx.workspace = payload.cwd != null ? String(payload.cwd) : ctx.workspace;
    ctx.model = payload.cli_version != null ? `Codex ${payload.cli_version}` : ctx.model;
    const thread = ctx.threadIndex?.get(ctx.sessionId);
    const title = thread?.threadName ? ` — ${thread.threadName}` : "";
    return codexRow({
      timestamp: formatTimestampUtc(tsMs),
      role: "system",
      recordType: "session_meta",
      summary: `[Session start]${title}`.trim(),
      sessionId: ctx.sessionId,
      messageId: payload.id != null ? String(payload.id) : "",
      parentId: "",
      workspace: ctx.workspace,
      toolName: "",
      isSidechain: !!ctx.isSidechainSession,
      gitBranch: "",
      model: ctx.model,
      sourceFile,
      user: attribution.user || "",
      host: attribution.host || "",
    });
  }

  if (recordType === "response_item") {
    const payloadType = payload.type != null ? String(payload.type) : "";

    if (payloadType === "message") {
      const role = payload.role != null ? String(payload.role) : "unknown";
      const summary = extractPayloadContent(payload.content);
      if (!summary) return null;
      return codexRow({
        timestamp: formatTimestampUtc(tsMs),
        role,
        recordType: "message",
        summary,
        toolName: "",
        sessionId: ctx.sessionId,
        messageId: payload.id != null ? String(payload.id) : "",
        parentId: "",
        workspace: ctx.workspace,
        isSidechain: !!ctx.isSidechainSession,
        gitBranch: "",
        model: ctx.model,
        sourceFile,
        user: attribution.user || "",
        host: attribution.host || "",
      });
    }

    if (payloadType === "function_call") {
      const name = payload.name != null ? String(payload.name) : "tool";
      let argPreview = "";
      try {
        if (payload.arguments) {
          argPreview = truncateSummary(
            typeof payload.arguments === "string" ? payload.arguments : JSON.stringify(payload.arguments),
          ).slice(0, 120);
        }
      } catch { /* ignore */ }
      const summary = argPreview ? `[Tool: ${name}] ${argPreview}` : `[Tool: ${name}]`;
      return codexRow({
        timestamp: formatTimestampUtc(tsMs),
        role: "assistant",
        recordType: "function_call",
        summary,
        toolName: name,
        sessionId: ctx.sessionId,
        messageId: payload.call_id != null ? String(payload.call_id) : "",
        parentId: "",
        workspace: ctx.workspace,
        isSidechain: !!ctx.isSidechainSession,
        gitBranch: "",
        model: ctx.model,
        sourceFile,
        user: attribution.user || "",
        host: attribution.host || "",
      });
    }

    if (payloadType === "function_call_output") {
      let outText = "";
      if (typeof payload.output === "string") outText = payload.output;
      else if (payload.output != null) {
        try { outText = JSON.stringify(payload.output); } catch { outText = String(payload.output); }
      }
      const summary = outText ? `[Tool output] ${truncateSummary(outText).slice(0, 200)}` : "[Tool output]";
      return codexRow({
        timestamp: formatTimestampUtc(tsMs),
        role: "tool",
        recordType: "function_call_output",
        summary,
        toolName: "",
        sessionId: ctx.sessionId,
        messageId: payload.call_id != null ? String(payload.call_id) : "",
        parentId: "",
        workspace: ctx.workspace,
        isSidechain: !!ctx.isSidechainSession,
        gitBranch: "",
        model: ctx.model,
        sourceFile,
        user: attribution.user || "",
        host: attribution.host || "",
      });
    }

    return codexRow({
      timestamp: formatTimestampUtc(tsMs),
      role: "system",
      recordType: payloadType || "response_item",
      summary: `[${payloadType || "response_item"}]`,
      sessionId: ctx.sessionId,
      messageId: "",
      parentId: "",
      workspace: ctx.workspace,
      toolName: "",
      isSidechain: !!ctx.isSidechainSession,
      gitBranch: "",
      model: ctx.model,
      sourceFile,
      user: attribution.user || "",
      host: attribution.host || "",
    });
  }

  if (recordType === "event_msg") {
    const evt = payload.type != null ? String(payload.type) : "event_msg";

    if (evt === "user_message") {
      const summary = stripCodexUserText(payload.message || payload.text || "");
      if (!summary) return null;
      return codexRow({
        timestamp: formatTimestampUtc(tsMs),
        role: "user",
        recordType: "user_message",
        summary,
        sessionId: ctx.sessionId,
        messageId: "",
        parentId: "",
        workspace: ctx.workspace,
        toolName: "",
        isSidechain: !!ctx.isSidechainSession,
        gitBranch: "",
        model: ctx.model,
        sourceFile,
        user: attribution.user || "",
        host: attribution.host || "",
      });
    }

    if (evt === "agent_reasoning") {
      const text = payload.text != null ? String(payload.text).trim() : "";
      return codexRow({
        timestamp: formatTimestampUtc(tsMs),
        role: "assistant",
        recordType: "agent_reasoning",
        summary: text ? `[Reasoning] ${truncateSummary(text).slice(0, 200)}` : "[Reasoning present]",
        sessionId: ctx.sessionId,
        messageId: "",
        parentId: "",
        workspace: ctx.workspace,
        toolName: "",
        isSidechain: !!ctx.isSidechainSession,
        gitBranch: "",
        model: ctx.model,
        sourceFile,
        user: attribution.user || "",
        host: attribution.host || "",
      });
    }

    if (evt === "token_count" && payload.info && typeof payload.info === "object") {
      const info = payload.info;
      const input = Number(info.input_tokens ?? info.prompt_tokens) || 0;
      const output = Number(info.output_tokens ?? info.completion_tokens) || 0;
      if (!input && !output) return null;
      return codexRow({
        timestamp: formatTimestampUtc(tsMs),
        role: "system",
        recordType: "token_count",
        summary: `Tokens: ${input} in / ${output} out`,
        sessionId: ctx.sessionId,
        messageId: "",
        parentId: "",
        workspace: ctx.workspace,
        toolName: "",
        isSidechain: !!ctx.isSidechainSession,
        gitBranch: "",
        model: ctx.model,
        inputTokens: input,
        outputTokens: output,
        sourceFile,
        user: attribution.user || "",
        host: attribution.host || "",
      });
    }

    return codexRow({
      timestamp: formatTimestampUtc(tsMs),
      role: "system",
      recordType: evt,
      summary: `[${evt}]`,
      sessionId: ctx.sessionId,
      messageId: "",
      parentId: "",
      workspace: ctx.workspace,
      toolName: "",
      isSidechain: !!ctx.isSidechainSession,
      gitBranch: "",
      model: ctx.model,
      sourceFile,
      user: attribution.user || "",
      host: attribution.host || "",
    });
  }

  if (recordType === "turn_context") {
    return codexRow({
      timestamp: formatTimestampUtc(tsMs),
      role: "system",
      recordType: "turn_context",
      summary: "[Turn context]",
      sessionId: ctx.sessionId,
      messageId: "",
      parentId: "",
      workspace: ctx.workspace,
      toolName: "",
      isSidechain: !!ctx.isSidechainSession,
      gitBranch: "",
      model: ctx.model,
      sourceFile,
      user: attribution.user || "",
      host: attribution.host || "",
    });
  }

  return codexRow({
    timestamp: formatTimestampUtc(tsMs),
    role: "system",
    recordType,
    summary: `[${recordType}]`,
    sessionId: ctx.sessionId,
    messageId: "",
    parentId: "",
    workspace: ctx.workspace,
    toolName: "",
    isSidechain: !!ctx.isSidechainSession,
    gitBranch: "",
    model: ctx.model,
    sourceFile,
    user: attribution.user || "",
    host: attribution.host || "",
  });
}

async function readJsonlFile(filePath, onLine, parseStats = null) {
  // Bounded reader: caps per-line size (one huge/newline-free rollout line can't OOM the worker)
  // and contains a per-line handler throw — a literal `null` line skips itself instead of
  // unwinding the loop and discarding every row already parsed from this file.
  await readJsonlBounded(filePath, onLine, { parseStats });
}

async function extractCodexHistoryFile(historyPath, attribution = {}, parseStats = null) {
  const rows = [];
  await readJsonlFile(historyPath, (obj, lineNumber) => {
    const row = assignLineNumber(parseCodexHistoryLine(obj, historyPath, attribution), lineNumber);
    if (row) rows.push(row);
  }, parseStats);
  return rows;
}

async function extractCodexRolloutFile(rolloutPath, threadIndex, attribution = {}, parseStats = null) {
  const ctx = {
    sessionId: "",
    workspace: "",
    model: "",
    threadIndex,
    isSidechainSession: false,
  };
  const rows = [];
  await readJsonlFile(rolloutPath, (obj, lineNumber) => {
    const row = assignLineNumber(parseRolloutEnvelope(obj, rolloutPath, ctx, attribution), lineNumber);
    if (row) rows.push(row);
  }, parseStats);
  return rows;
}

/**
 * Extract all Codex rows from a ~/.codex directory.
 */
async function extractCodexDir(codexRoot, attribution = {}, options = {}) {
  const rows = [];
  const parseStats = { errors: 0 };
  const threadIndex = loadThreadIndex(codexRoot);
  const rolloutPaths = listRolloutFiles(codexRoot, options);
  const historyPath = path.join(codexRoot, "history.jsonl");
  const hasHistory = fs.existsSync(historyPath) && peekHistoryJsonl(historyPath);
  const fileCount = (hasHistory ? 1 : 0) + rolloutPaths.length;
  let fileIndex = 0;
  const { onFileProgress, onExtractedRows } = options;

  const emitBatch = (batch) => {
    if (!batch?.length) return;
    const filtered = filterSidechainRows(batch, options);
    if (onExtractedRows && filtered.length) {
      onExtractedRows(filtered);
      return;
    }
    rows.push(...filtered);
  };

  if (hasHistory) {
    fileIndex += 1;
    tickFileProgress(onFileProgress, fileIndex, fileCount, historyPath);
    try {
      emitBatch(await extractCodexHistoryFile(historyPath, attribution, parseStats));
    } catch (e) {
      dbg("AIHIST", "codex history.jsonl failed", { path: historyPath, err: e.message });
    }
  }

  for (const rolloutPath of rolloutPaths) {
    fileIndex += 1;
    tickFileProgress(onFileProgress, fileIndex, fileCount, rolloutPath);
    try {
      emitBatch(await extractCodexRolloutFile(rolloutPath, threadIndex, attribution, parseStats));
    } catch (e) {
      dbg("AIHIST", "codex rollout failed", { path: rolloutPath, err: e.message });
    }
    if (fileIndex % 8 === 0) await new Promise((r) => setImmediate(r));
  }

  const { supplementCodexFromStateSqlite } = require("./codex-state-sqlite");
  const { rows: sqliteRows, stats: sqliteStats } = supplementCodexFromStateSqlite(codexRoot, attribution, options);
  if (sqliteRows.length) emitBatch(sqliteRows);

  if (onExtractedRows) {
    const out = [];
    if (sqliteStats) out._codexStateSqliteStats = sqliteStats;
    if (parseStats.errors) out._parseErrors = parseStats.errors;
    return out;
  }

  const finalized = finalizeAiHistoryRows(filterSidechainRows(rows, options), options);
  if (sqliteStats) finalized._codexStateSqliteStats = sqliteStats;
  if (parseStats.errors) finalized._parseErrors = parseStats.errors;
  return finalized;
}

async function extractCodexPath(target, attribution = {}, options = {}) {
  if (!target || !fs.existsSync(target)) {
    throw new Error(`Path does not exist: ${target}`);
  }

  let stat;
  try { stat = fs.statSync(target); } catch (e) {
    throw new Error(`Cannot read path: ${e.message}`);
  }

  if (stat.isDirectory()) {
    const root = resolveCodexHome(target);
    if (!root) throw new Error("Not an OpenAI Codex .codex directory.");
    return extractCodexDir(root, attribution, options);
  }

  const ext = path.extname(target).toLowerCase();
  if (ext !== ".jsonl") {
    throw new Error("Expected a .jsonl file or a .codex directory.");
  }

  const codexRoot = resolveCodexHome(target);
  const threadIndex = codexRoot ? loadThreadIndex(codexRoot) : new Map();

  if (path.basename(target) === "history.jsonl" && peekHistoryJsonl(target)) {
    const rows = await extractCodexHistoryFile(target, attribution);
    for (let i = 0; i < rows.length; i++) rows[i].RecordId = String(i + 1);
    return rows;
  }

  if (isCodexRolloutFile(target)) {
    const rows = await extractCodexRolloutFile(target, threadIndex, attribution);
    for (let i = 0; i < rows.length; i++) rows[i].RecordId = String(i + 1);
    return rows;
  }

  throw new Error("Unrecognized Codex JSONL file (expected history.jsonl or rollout-*.jsonl under .codex).");
}

function defaultCodexHome() {
  const env = process.env.CODEX_HOME;
  if (env && fs.existsSync(env)) return env;
  return path.join(os.homedir(), CODEX_DIR_NAME);
}

module.exports = {
  CODEX_DIR_NAME,
  ROLLOUT_FILE_RE,
  resolveCodexHome,
  isCodexDir,
  isCodexRolloutFile,
  listRolloutFiles,
  countRolloutFiles,
  stripCodexUserText,
  extractPayloadContent,
  parseCodexHistoryLine,
  parseRolloutEnvelope,
  isCodexForkedSession,
  extractCodexDir,
  extractCodexPath,
  defaultCodexHome,
};
