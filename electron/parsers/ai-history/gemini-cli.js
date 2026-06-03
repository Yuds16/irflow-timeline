/**
 * parsers/ai-history/gemini-cli.js — Google Gemini CLI session extraction.
 *
 * Artifacts:
 * - ~/.gemini/tmp/<hash>/chats/session-*.json — { messages: [{ type, content, … }] }
 * - ~/.gemini/tmp/<hash>/logs.json — legacy CLI log array [{ type, message, timestamp, sessionId, messageId }]
 */

const fs = require("fs");
const path = require("path");

const { dbg } = require("../../logger");
const { tickFileProgress } = require("./extract-plan");
const { TOOL_GEMINI_CLI } = require("./schema");
const { formatTimestampUtc, parseIsoTimestamp, makeRow, finalizeAiHistoryRows } = require("./row-utils");
const { parseChatgptTimestamp } = require("./chatgpt");

const GEMINI_DIR_NAME = ".gemini";
const LOGS_FILE_NAME = "logs.json";
const SESSION_FILE_RE = /^session-.+\.json$/i;
const CHECKPOINT_FILE_RE = /^checkpoint-.+\.json$/i;

const ROLE_BY_TYPE = {
  user: "user",
  gemini: "assistant",
  assistant: "assistant",
  model: "assistant",
  system: "system",
  error: "system",
  info: "system",
  tool: "tool",
  function: "tool",
};

function parseMessageTimestamp(value, fallbackMs) {
  if (value == null || value === "") {
    return fallbackMs != null ? fallbackMs : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  return parseChatgptTimestamp(value) ?? parseIsoTimestamp(String(value));
}

function parseTokenCounts(tokens) {
  if (!tokens || typeof tokens !== "object") return { input: 0, output: 0 };
  const input = tokens.input ?? tokens.inputTokens ?? tokens.prompt ?? tokens.promptTokenCount ?? 0;
  const output = tokens.output ?? tokens.outputTokens ?? tokens.completion ?? tokens.candidatesTokenCount ?? 0;
  return {
    input: Number(input) || 0,
    output: Number(output) || 0,
  };
}

function normalizeContent(content, thoughts) {
  let text = "";
  if (typeof content === "string") text = content.trim();
  else if (Array.isArray(content)) {
    text = content.map((p) => {
      if (typeof p === "string") return p;
      if (p && typeof p === "object") return p.text || p.content || "";
      return "";
    }).filter(Boolean).join(" ");
  } else if (content && typeof content === "object") {
    text = String(content.text || content.content || "").trim();
  }
  if (!text && thoughts) text = "[Reasoning only]";
  else if (thoughts && String(thoughts).trim()) text = `${text} [Reasoning present]`.trim();
  return text;
}

function geminiRow(fields) {
  return makeRow({ ...fields, tool: fields.tool || TOOL_GEMINI_CLI }, TOOL_GEMINI_CLI);
}

/**
 * Parse one Gemini CLI session JSON file into timeline rows.
 */
function extractGeminiSessionFile(sessionPath, attribution = {}) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  } catch (e) {
    dbg("AIHIST", "gemini session parse failed", { sessionPath, err: e.message });
    return [];
  }

  // JSON.parse("null") (and primitives/arrays) survive the try/catch above; guard before deref.
  if (!data || typeof data !== "object") return [];
  const messages = Array.isArray(data.messages) ? data.messages : [];
  if (!messages.length) return [];

  const sessionId = data.sessionId != null ? String(data.sessionId) : "";
  const workspace = data.projectHash != null ? String(data.projectHash) : "";
  const sessionFallback = parseMessageTimestamp(data.startTime)
    ?? parseMessageTimestamp(data.lastUpdated);

  const rows = [];
  let idx = 0;

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (!msg || typeof msg !== "object") continue; // null/primitive element — skip, don't deref
    const msgType = msg.type != null ? String(msg.type).toLowerCase() : "";
    const role = ROLE_BY_TYPE[msgType] || (msgType ? "system" : "");

    let summary = normalizeContent(msg.content, msg.thoughts);
    if (!summary && msg.message != null) summary = String(msg.message).trim();
    if (!summary && msg.error) summary = String(msg.error).trim();
    if (!summary && msgType === "error") summary = "[Error event]";
    if (!summary && role) summary = `[${msgType || role} event]`;
    if (!summary) continue;

    const tsMs = parseMessageTimestamp(msg.timestamp, sessionFallback);
    if (tsMs == null) continue;

    const tokens = parseTokenCounts(msg.tokens);
    idx += 1;
    rows.push(geminiRow({
      timestamp: formatTimestampUtc(tsMs),
      role: role || "system",
      recordType: msgType || role || "event",
      summary,
      toolName: "",
      sessionId,
      messageId: `${sessionId || path.basename(sessionPath)}-${idx}`,
      parentId: "",
      workspace,
      isSidechain: false,
      gitBranch: "",
      model: msg.model != null ? String(msg.model) : "",
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      sourceFile: sessionPath,
      lineNumber: msgIdx + 1,
      user: attribution.user || "",
      host: attribution.host || "",
    }));
  }

  return rows;
}

/**
 * Parse legacy tmp/<hash>/logs.json (array of { type, message, timestamp, sessionId, messageId }).
 */
function extractGeminiLogsFile(logsPath, attribution = {}) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(logsPath, "utf8"));
  } catch (e) {
    dbg("AIHIST", "gemini logs parse failed", { logsPath, err: e.message });
    return [];
  }

  const entries = Array.isArray(data)
    ? data
    : (Array.isArray(data?.messages) ? data.messages : (Array.isArray(data?.logs) ? data.logs : []));
  if (!entries.length) return [];

  const workspace = path.basename(path.dirname(logsPath));
  const rows = [];

  for (let msgIdx = 0; msgIdx < entries.length; msgIdx++) {
    const msg = entries[msgIdx];
    if (!msg || typeof msg !== "object") continue;

    const msgType = msg.type != null ? String(msg.type).toLowerCase() : "";
    const role = ROLE_BY_TYPE[msgType] || (msgType ? "system" : "user");

    let summary = normalizeContent(msg.content ?? msg.message, msg.thoughts);
    if (!summary && msg.error) summary = String(msg.error).trim();
    if (!summary && msgType === "error") summary = "[Error event]";
    if (!summary && role) summary = `[${msgType || role} event]`;
    if (!summary) continue;

    const tsMs = parseMessageTimestamp(msg.timestamp);
    if (tsMs == null) continue;

    const sessionId = msg.sessionId != null ? String(msg.sessionId) : "";
    const msgKey = msg.messageId != null ? String(msg.messageId) : String(msgIdx + 1);
    const tokens = parseTokenCounts(msg.tokens);

    rows.push(geminiRow({
      timestamp: formatTimestampUtc(tsMs),
      role: role || "user",
      recordType: msgType || role || "event",
      summary,
      toolName: "",
      sessionId,
      messageId: sessionId ? `${sessionId}-${msgKey}` : `${path.basename(logsPath)}-${msgKey}`,
      parentId: "",
      workspace,
      isSidechain: false,
      gitBranch: "",
      model: msg.model != null ? String(msg.model) : "",
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      sourceFile: logsPath,
      lineNumber: msgIdx + 1,
      user: attribution.user || "",
      host: attribution.host || "",
    }));
  }

  return rows;
}

function isGeminiLogsFile(filePath) {
  if (!filePath || path.basename(filePath) !== LOGS_FILE_NAME) return false;
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  return norm.includes(`/${GEMINI_DIR_NAME}/tmp/`);
}

function isGeminiSessionFile(filePath) {
  const base = path.basename(filePath);
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  if (!norm.includes(`/${GEMINI_DIR_NAME}/`)) return false;
  if (SESSION_FILE_RE.test(base)) return norm.includes("/chats/");
  if (CHECKPOINT_FILE_RE.test(base)) return norm.includes("/tmp/");
  return false;
}

function isGeminiDataFile(filePath) {
  return isGeminiSessionFile(filePath) || isGeminiLogsFile(filePath);
}

function walkGeminiTmp(geminiRoot, onFile, limits = { maxDirs: 96, maxDepth: 6 }) {
  const tmpDir = path.join(geminiRoot, "tmp");
  if (!fs.existsSync(tmpDir)) return;
  let dirsVisited = 0;
  const stack = [{ d: tmpDir, depth: 0 }];
  while (stack.length && dirsVisited < limits.maxDirs) {
    const { d, depth } = stack.pop();
    dirsVisited += 1;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isFile()) onFile(full);
      if (e.isDirectory() && depth < limits.maxDepth && !e.isSymbolicLink()) {
        stack.push({ d: full, depth: depth + 1 });
      }
    }
  }
}

/** Fast existence check for discovery (bounded walk — avoids hanging on huge ~/.gemini/tmp). */
function hasGeminiSessionsQuick(geminiRoot, limits = { maxDirs: 96, maxDepth: 6 }) {
  const tmpDir = path.join(geminiRoot, "tmp");
  if (!fs.existsSync(tmpDir)) return false;
  let found = false;
  walkGeminiTmp(geminiRoot, (full) => {
    if (!found && isGeminiDataFile(full)) found = true;
  }, limits);
  return found;
}

/** List session-*.json files under geminiRoot/tmp/.../chats/ */
function listSessionJsonFiles(geminiRoot) {
  const out = [];
  walkGeminiTmp(geminiRoot, (full) => {
    if (isGeminiSessionFile(full)) out.push(full);
  }, { maxDirs: 10_000, maxDepth: 12 });
  return out;
}

/** List tmp/<hash>/logs.json files (legacy Gemini CLI conversation log). */
function listLogsJsonFiles(geminiRoot) {
  const out = [];
  walkGeminiTmp(geminiRoot, (full) => {
    if (isGeminiLogsFile(full)) out.push(full);
  }, { maxDirs: 10_000, maxDepth: 12 });
  return out;
}

/** All parseable Gemini CLI JSON artifacts under a .gemini root. */
function listGeminiDataFiles(geminiRoot) {
  return [...listSessionJsonFiles(geminiRoot), ...listLogsJsonFiles(geminiRoot)];
}

function isGeminiCliRoot(dirPath, { quick = false } = {}) {
  if (!dirPath || !fs.existsSync(dirPath)) return false;
  try {
    if (!fs.statSync(dirPath).isDirectory()) return false;
  } catch { return false; }
  if (quick) return hasGeminiSessionsQuick(dirPath);
  return listGeminiDataFiles(dirPath).length > 0;
}

function extractGeminiDataFile(filePath, attribution) {
  if (isGeminiLogsFile(filePath)) return extractGeminiLogsFile(filePath, attribution);
  return extractGeminiSessionFile(filePath, attribution);
}

async function extractGeminiCliDir(geminiRoot, attribution = {}, options = {}) {
  const rows = [];
  const dataPaths = listGeminiDataFiles(geminiRoot);
  const fileCount = dataPaths.length;
  const { onFileProgress } = options;

  for (let i = 0; i < dataPaths.length; i++) {
    const dataPath = dataPaths[i];
    tickFileProgress(onFileProgress, i + 1, fileCount, dataPath);
    try {
      rows.push(...extractGeminiDataFile(dataPath, attribution));
    } catch (e) {
      dbg("AIHIST", "gemini extract failed", { dataPath, err: e.message });
    }
    if ((i + 1) % 16 === 0) await new Promise((r) => setImmediate(r));
  }
  return finalizeAiHistoryRows(rows, options);
}

function resolveGeminiCliRoot(target) {
  if (!target) return null;
  let p = target;
  try {
    if (fs.statSync(p).isFile()) p = path.dirname(p);
  } catch { return null; }

  for (let i = 0; i < 12; i++) {
    if (path.basename(p) === GEMINI_DIR_NAME && listGeminiDataFiles(p).length > 0) return p;
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  if (isGeminiCliRoot(target)) return target;
  return null;
}

async function extractGeminiCliPath(target, attribution = {}, options = {}) {
  if (!target || !fs.existsSync(target)) {
    throw new Error(`Path does not exist: ${target}`);
  }

  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (!isGeminiDataFile(target)) {
      throw new Error("Expected a Gemini CLI session-*.json (chats/) or logs.json (tmp/) file.");
    }
    return finalizeAiHistoryRows(extractGeminiDataFile(target, attribution), options);
  }

  const root = resolveGeminiCliRoot(target);
  if (!root || !isGeminiCliRoot(root)) {
    throw new Error("Not a Gemini CLI .gemini directory (expected tmp/.../chats/session-*.json or tmp/.../logs.json).");
  }
  return extractGeminiCliDir(root, attribution, options);
}

/** Count parseable data files (for triage manifest sizing). */
function countGeminiSessions(geminiRoot) {
  return listGeminiDataFiles(geminiRoot).length;
}

module.exports = {
  GEMINI_DIR_NAME,
  extractGeminiSessionFile,
  extractGeminiLogsFile,
  extractGeminiCliDir,
  extractGeminiCliPath,
  isGeminiCliRoot,
  isGeminiSessionFile,
  isGeminiLogsFile,
  isGeminiDataFile,
  resolveGeminiCliRoot,
  hasGeminiSessionsQuick,
  listSessionJsonFiles,
  listLogsJsonFiles,
  listGeminiDataFiles,
  countGeminiSessions,
};
