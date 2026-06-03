/**
 * cursor-composer.js — Cursor composer chat extraction from state.vscdb / store.db.
 */

const fs = require("fs");
const path = require("path");

const { dbg } = require("../../logger");
const { TOOL_CURSOR } = require("./schema");
const { tickFileProgress } = require("./extract-plan");
const {
  formatTimestampUtc,
  makeRow,
  assignLineNumber,
} = require("./row-utils");
const {
  openVscdbReadOnly,
  listComposerDataRows,
  loadBubblesForComposer,
  parseKvValue,
  findVscdbFilesUnder,
  readWorkspaceJsonMap,
  safeCloseDb,
} = require("./vscdb-kv");
const { formatWorkspaceDisplay } = require("./workspace-utils");
const { defaultCursorHome, listCursorUserDataDirs } = require("./artifact-paths");

const CURSOR_DIR_NAME = ".cursor";
const COMPOSER_YIELD_EVERY = 8;

function cursorComposerRow(fields) {
  return makeRow({ ...fields, tool: TOOL_CURSOR }, TOOL_CURSOR);
}

function bubbleRole(type) {
  const n = Number(type);
  if (n === 1) return "user";
  if (n === 2) return "assistant";
  return null;
}

function bubbleText(bubble) {
  if (!bubble || typeof bubble !== "object") return "";
  if (bubble.text != null && String(bubble.text).trim()) return String(bubble.text).trim();
  if (bubble.rawText != null && String(bubble.rawText).trim()) return String(bubble.rawText).trim();
  if (Array.isArray(bubble.richText)) {
    return bubble.richText.map((p) => (p && p.text) || "").filter(Boolean).join(" ").trim();
  }
  return "";
}

function parseBubbleRow(bubble, composerId, sourceFile, attribution, workspace, headerIndex) {
  const role = bubbleRole(bubble.type);
  if (!role) return null;
  const summary = bubbleText(bubble);
  if (!summary) return null;

  let tsMs = null;
  if (bubble.createdAt != null) {
    const n = Number(bubble.createdAt);
    if (Number.isFinite(n)) tsMs = n > 1e12 ? n : n * 1000;
  }
  if (tsMs == null && bubble.timestamp != null) {
    const n = Number(bubble.timestamp);
    if (Number.isFinite(n)) tsMs = n > 1e12 ? n : n * 1000;
  }

  const usage = bubble.tokenCount || bubble.usage || {};
  const inputTokens = usage.inputTokens ?? usage.input_tokens ?? "";
  const outputTokens = usage.outputTokens ?? usage.output_tokens ?? "";

  return cursorComposerRow({
    timestamp: tsMs != null ? formatTimestampUtc(tsMs) : "",
    role,
    recordType: role,
    summary,
    sessionId: composerId,
    messageId: bubble.bubbleId != null ? String(bubble.bubbleId) : "",
    workspace,
    sourceFile,
    lineNumber: headerIndex != null ? String(headerIndex) : "",
    inputTokens: inputTokens !== "" ? String(inputTokens) : "",
    outputTokens: outputTokens !== "" ? String(outputTokens) : "",
    user: attribution.user || "",
    host: attribution.host || "",
  });
}

function extractComposerSessionRows(compData, composerId, db, dbPath, attribution, workspaceLabel) {
  const rows = [];
  let headers = [];
  if (compData && Array.isArray(compData.fullConversationHeadersOnly)) {
    headers = compData.fullConversationHeadersOnly;
  }

  if (headers.length) {
    let idx = 0;
    for (const h of headers) {
      idx += 1;
      const bubbleId = h.bubbleId || h.id;
      if (!bubbleId) continue;
      const key = `bubbleId:${composerId}:${bubbleId}`;
      let bubble = null;
      try {
        const row = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(key);
        if (row) bubble = parseKvValue(row.value);
      } catch { /* ignore */ }
      const row = parseBubbleRow(
        bubble || { type: h.type, text: "" },
        composerId,
        dbPath,
        attribution,
        workspaceLabel,
        idx,
      );
      if (row && bubbleText(bubble || {})) rows.push(assignLineNumber(row, idx));
    }
    return rows;
  }

  const bubbles = loadBubblesForComposer(db, composerId);
  let idx = 0;
  for (const bubble of bubbles) {
    idx += 1;
    const row = parseBubbleRow(bubble, composerId, dbPath, attribution, workspaceLabel, idx);
    if (row) rows.push(assignLineNumber(row, idx));
  }
  return rows;
}

async function extractBubblesFromDb(db, dbPath, attribution, workspaceLabel, options = {}) {
  const rows = [];
  let messageRows = 0;
  const composerRows = listComposerDataRows(db);
  const { checkAbort, onComposerProgress, onExtractedRows } = options;
  let composersDone = 0;

  for (const { key, value } of composerRows) {
    composersDone += 1;
    if (typeof checkAbort === "function") checkAbort();
    if (typeof onComposerProgress === "function") {
      onComposerProgress(composersDone, composerRows.length, dbPath);
    }

    const composerId = key.slice("composerData:".length);
    if (!composerId) continue;
    const compData = parseKvValue(value);
    const chunk = extractComposerSessionRows(
      compData,
      composerId,
      db,
      dbPath,
      attribution,
      workspaceLabel,
    );
    if (chunk.length) {
      messageRows += chunk.length;
      if (onExtractedRows) onExtractedRows(chunk);
      else rows.push(...chunk);
    }

    if (composersDone % COMPOSER_YIELD_EVERY === 0) {
      await new Promise((r) => setImmediate(r));
    }
  }

  rows._extractedCount = messageRows;
  return rows;
}

function workspaceLabelForDb(dbPath, cursorHome) {
  const norm = dbPath.replace(/\\/g, "/");
  const wsMatch = norm.match(/workspaceStorage\/([^/]+)\//i);
  if (wsMatch && cursorHome) {
    const map = readWorkspaceJsonMap(cursorHome);
    const folder = map.get(wsMatch[1]);
    if (folder) return formatWorkspaceDisplay(folder, folder);
  }
  if (norm.includes("/chats/")) {
    const slug = norm.split("/chats/")[1]?.split("/")[0];
    if (slug) return `Cursor chat workspace ${slug}`;
  }
  if (norm.includes("globalStorage")) return "Cursor (global composer)";
  return "Cursor composer";
}

function listCursorComposerDbs(cursorRoot, extraUserDirs = []) {
  const agentHome = path.basename(cursorRoot) === CURSOR_DIR_NAME
    ? cursorRoot
    : (fs.existsSync(path.join(cursorRoot, "projects")) ? cursorRoot : defaultCursorHome());

  const dbs = new Set();
  const userDirs = [...extraUserDirs, ...listCursorUserDataDirs()];
  for (const userDir of userDirs) {
    const globalVscdb = path.join(userDir, "globalStorage", "state.vscdb");
    if (fs.existsSync(globalVscdb)) dbs.add(globalVscdb);
    for (const p of findVscdbFilesUnder(userDir, { maxDepth: 6, maxFiles: 20 })) {
      dbs.add(p);
    }
  }

  const chatsDir = path.join(agentHome, "chats");
  if (fs.existsSync(chatsDir)) {
    for (const p of findVscdbFilesUnder(chatsDir, { maxDepth: 10, maxFiles: 16 })) {
      dbs.add(p);
    }
  }

  return [...dbs];
}

/**
 * @param {string} cursorRoot — ~/.cursor or Cursor User folder
 */
async function extractCursorComposerStores(cursorRoot, attribution = {}, options = {}) {
  const rows = [];
  const stats = { databases: 0, messageRows: 0, failed: 0 };
  const agentHome = path.basename(cursorRoot) === CURSOR_DIR_NAME
    ? cursorRoot
    : defaultCursorHome();

  const dbPaths = listCursorComposerDbs(agentHome, options.userDataDirs || []);
  let fileIndex = 0;
  const { onFileProgress, checkAbort, onExtractedRows } = options;

  for (const dbPath of dbPaths) {
    fileIndex += 1;
    tickFileProgress(onFileProgress, fileIndex, dbPaths.length, dbPath);
    if (typeof checkAbort === "function") checkAbort();

    let db;
    try {
      db = openVscdbReadOnly(dbPath);
      stats.databases += 1;
      const ws = workspaceLabelForDb(dbPath, listCursorUserDataDirs()[0] || agentHome);
      const chunk = await extractBubblesFromDb(db, dbPath, attribution, ws, {
        checkAbort,
        onExtractedRows,
        onComposerProgress: (composerIndex, composerTotal) => {
          if (typeof onFileProgress !== "function") return;
          const base = path.basename(dbPath);
          const detail = composerTotal > 0
            ? `${base} — composers ${composerIndex}/${composerTotal}`
            : base;
          onFileProgress(fileIndex, dbPaths.length, detail);
        },
      });
      const extracted = chunk._extractedCount ?? chunk.length;
      stats.messageRows += extracted;
      if (!onExtractedRows) rows.push(...chunk);
    } catch (e) {
      stats.failed += 1;
      dbg("AIHIST", "cursor composer db failed", { dbPath, err: e.message });
    } finally {
      safeCloseDb(db);
    }
    if (fileIndex % 2 === 0) await new Promise((r) => setImmediate(r));
  }

  if (onExtractedRows) {
    const out = [];
    out._cursorComposerStats = stats;
    return { rows: out, stats };
  }

  return { rows, stats };
}

function buildCursorComposerImportNotice(stats) {
  if (!stats || !stats.databases) return "";
  if (stats.messageRows > 0) {
    return `Cursor composer DB: ${stats.messageRows} message(s) from ${stats.databases} SQLite store(s).`;
  }
  return `Cursor composer DB: opened ${stats.databases} store(s) but no bubble messages found.`;
}

module.exports = {
  extractCursorComposerStores,
  extractBubblesFromDb,
  listCursorComposerDbs,
  buildCursorComposerImportNotice,
};
