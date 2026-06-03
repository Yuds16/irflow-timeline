/**
 * vscode-chat-db.js — VS Code / Windsurf / Copilot workspace state.vscdb chat extraction.
 *
 * Reads legacy ItemTable keys (aiService.prompts, aichat.chatdata) when chatSessions JSON is empty.
 */

const fs = require("fs");
const path = require("path");

const { dbg } = require("../../logger");
const { tickFileProgress } = require("./extract-plan");
const {
  openVscdbReadOnly,
  kvTableNames,
  parseKvValue,
  queryKvByKey,
  findVscdbFilesUnder,
  safeCloseDb,
} = require("./vscdb-kv");
const { formatTimestampUtc, parseIsoTimestamp, makeRow, sortAndNumberRows } = require("./row-utils");

function messageTimestampMs(msg) {
  // Return null (-> blank Timestamp) when there is no real timestamp. Fabricating one from
  // Date.now() injected the import-time wall clock into the forensic timeline as if it were the
  // event time, with no synthetic marker — mis-ordering the incident timeline. Blank = unknown,
  // matching the app's naive=UTC / blank=unknown convention.
  const raw = msg?.timestamp ?? msg?.createdAt;
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  return parseIsoTimestamp(raw);
}

const ITEM_CHAT_KEYS = [
  "aiService.prompts",
  "aiService.generations",
  "workbench.panel.aichat.view.aichat.chatdata",
  "workbench.panel.chat.view.chat.response",
  "workbench.panel.chat.view.copilot.chatdata",
];

function textFromPromptEntry(entry) {
  if (entry == null) return "";
  if (typeof entry === "string") return entry.trim();
  if (typeof entry === "object") {
    const t = entry.text ?? entry.message ?? entry.content ?? entry.query ?? entry.response;
    if (typeof t === "string") return t.trim();
    if (Array.isArray(t)) return t.map((p) => textFromPromptEntry(p)).filter(Boolean).join(" ");
  }
  return "";
}

function rowsFromPromptArray(data, sessionId, sourceFile, toolLabel, attribution, workspace) {
  const rows = [];
  if (!Array.isArray(data)) return rows;
  let idx = 0;
  for (const entry of data) {
    idx += 1;
    const text = textFromPromptEntry(entry);
    if (!text) continue;
    const role = typeof entry === "object" && entry.role
      ? String(entry.role).toLowerCase()
      : (idx % 2 === 1 ? "user" : "assistant");
    if (role !== "user" && role !== "assistant") continue;
    rows.push(makeRow({
      // Use the entry's own timestamp if present; never fabricate a Date.now()-derived series.
      timestamp: formatTimestampUtc(messageTimestampMs(entry)),
      role,
      recordType: role,
      summary: text,
      sessionId: sessionId || "vscdb-prompts",
      messageId: String(idx),
      workspace,
      sourceFile,
      user: attribution.user || "",
      host: attribution.host || "",
      tool: toolLabel,
    }, toolLabel));
  }
  return rows;
}

function rowsFromChatData(data, sessionId, sourceFile, toolLabel, attribution, workspace) {
  const rows = [];
  if (!data || typeof data !== "object") return rows;

  const tabs = data.tabs || data.sessions || data.chats;
  if (Array.isArray(tabs)) {
    for (const tab of tabs) {
      if (!tab || typeof tab !== "object") continue; // null/primitive tab — skip, don't deref
      const tabId = tab.id || tab.sessionId || tab.chatId || sessionId;
      const messages = tab.messages || tab.bubbles || tab.history;
      if (!Array.isArray(messages)) continue;
      let idx = 0;
      for (const msg of messages) {
        idx += 1;
        if (!msg || typeof msg !== "object") continue; // null/primitive message — skip
        const role = String(msg.role || msg.type || "").toLowerCase();
        const text = textFromPromptEntry(msg.message || msg) || textFromPromptEntry(msg);
        if (!text || (role !== "user" && role !== "assistant" && role !== "1" && role !== "2")) {
          if (text) {
            rows.push(makeRow({
              timestamp: "",
              role: "user",
              recordType: "message",
              summary: text,
              sessionId: String(tabId),
              messageId: String(idx),
              workspace,
              sourceFile,
              user: attribution.user || "",
              host: attribution.host || "",
              tool: toolLabel,
            }, toolLabel));
          }
          continue;
        }
        const normRole = role === "1" || role === "user" ? "user" : "assistant";
        rows.push(makeRow({
          timestamp: formatTimestampUtc(messageTimestampMs(msg)),
          role: normRole,
          recordType: normRole,
          summary: text,
          sessionId: String(tabId),
          messageId: String(idx),
          workspace,
          sourceFile,
          user: attribution.user || "",
          host: attribution.host || "",
          tool: toolLabel,
        }, toolLabel));
      }
    }
  }
  return rows;
}

function extractChatFromVscdb(dbPath, toolLabel, attribution, workspaceLabel) {
  const rows = [];
  let db;
  try {
    db = openVscdbReadOnly(dbPath);
    const tables = kvTableNames(db);
    if (!tables.includes("ItemTable")) return rows;

    for (const key of ITEM_CHAT_KEYS) {
      const row = queryKvByKey(db, "ItemTable", key);
      if (!row) continue;
      const data = parseKvValue(row.value);
      const sid = `${path.basename(path.dirname(dbPath))}:${key}`;
      if (key.includes("prompts") || key.includes("generations")) {
        rows.push(...rowsFromPromptArray(data, sid, dbPath, toolLabel, attribution, workspaceLabel));
      } else {
        rows.push(...rowsFromChatData(data, sid, dbPath, toolLabel, attribution, workspaceLabel));
      }
    }
  } catch (e) {
    dbg("AIHIST", "vscode-chat-db extract failed", { dbPath, err: e.message });
  } finally {
    safeCloseDb(db);
  }
  return rows;
}

/**
 * Scan a VS Code–family User directory (workspaceStorage + globalStorage).
 */
async function extractVsCodeUserChatDir(userDir, toolLabel, attribution = {}, options = {}) {
  const rows = [];
  if (!userDir || !fs.existsSync(userDir)) return { rows, stats: { databases: 0, messageRows: 0 } };

  const dbs = new Set();
  const globalDb = path.join(userDir, "globalStorage", "state.vscdb");
  if (fs.existsSync(globalDb)) dbs.add(globalDb);
  const wsRoot = path.join(userDir, "workspaceStorage");
  if (fs.existsSync(wsRoot)) {
    for (const p of findVscdbFilesUnder(wsRoot, { maxDepth: 3, maxFiles: 24 })) {
      dbs.add(p);
    }
  }

  const dbList = [...dbs];
  let fileIndex = 0;
  const { onFileProgress, checkAbort } = options;

  for (const dbPath of dbList) {
    if (typeof checkAbort === "function") checkAbort();
    fileIndex += 1;
    tickFileProgress(onFileProgress, fileIndex, dbList.length, dbPath);
    const wsLabel = dbPath.includes("workspaceStorage")
      ? path.basename(path.dirname(dbPath))
      : "global";
    rows.push(...extractChatFromVscdb(dbPath, toolLabel, attribution, wsLabel));
    if (fileIndex % 3 === 0) await new Promise((r) => setImmediate(r));
  }

  return {
    rows,
    stats: { databases: dbList.length, messageRows: rows.length },
  };
}

function buildVsCodeChatImportNotice(toolLabel, stats) {
  if (!stats?.messageRows) return "";
  return `${toolLabel} workspace DB: ${stats.messageRows} message(s) from ${stats.databases} state.vscdb file(s).`;
}

module.exports = {
  extractVsCodeUserChatDir,
  extractChatFromVscdb,
  buildVsCodeChatImportNotice,
  messageTimestampMs,
};
