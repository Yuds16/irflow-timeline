/**
 * parsers/ai-history/chatgpt.js — ChatGPT Desktop local store extraction.
 *
 * Handles Electron LevelDB conversation metadata (.ldb/.log) and SQLite message DBs when
 * present. Full message bodies depend on the app version; metadata (title, timestamps) is
 * always attempted from LevelDB.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { dbg } = require("../../logger");
const { TOOL_CHATGPT } = require("./schema");
const { tickFileProgress } = require("./extract-plan");
const { formatTimestampUtc, parseIsoTimestamp, makeRow, finalizeAiHistoryRows } = require("./row-utils");

const MAX_LEVELDB_BYTES = 64 * 1024 * 1024;
// Bounded recovery limits so a crafted/large LevelDB byte stream cannot pin the worker (DoS).
// The raw scan is best-effort carving over untrusted bytes; these caps keep it strictly linear.
const MAX_LEVELDB_OBJECT_BYTES = 4 * 1024 * 1024; // cap on one recovered JSON array/object
const LEVELDB_BACKSCAN_WINDOW = 8 * 1024;         // how far back to look for an enclosing '{'
const MAX_LEVELDB_MATCHES = 50_000;               // cap key occurrences scanned per file

// Char codes for the hot scan loops — charCodeAt avoids allocating a one-char string per index.
const CC_QUOTE = 34;   // "
const CC_BACKSLASH = 92; // \
const CC_OBRACE = 123; // {
const CC_OBRACKET = 91; // [

function isSqliteFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    return buf.slice(0, 6).toString("latin1") === "SQLite";
  } catch {
    return false;
  } finally {
    // Always release the descriptor — readSync can throw after openSync succeeds (EIO on
    // damaged media), and a leaked fd per failing file eventually exhausts the fd table (EMFILE).
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function isLeveldbWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isInLeveldbDir(filePath) {
  const lower = filePath.toLowerCase();
  return lower.includes("leveldb")
    || lower.includes("local storage")
    || lower.includes("localstorage")
    || lower.includes("indexeddb");
}

function parseChatgptTimestamp(s) {
  if (s == null || s === "") return null;
  if (typeof s === "number" && Number.isFinite(s)) {
    if (s > 1e12) return s;
    if (s > 1e9) return s * 1000;
    return null;
  }
  const str = String(s).trim();
  if (!str) return null;
  const iso = parseIsoTimestamp(str);
  if (iso != null) return iso;
  if (/^\d{10}(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 1000);
  if (/^\d{13}$/.test(str)) return parseInt(str, 10);
  return null;
}

// Scan `text` in place from `start` for a balanced open/close pair, bounded by maxLen.
// Returns the single matched substring (one slice) or null. Scanning in place — rather than
// slicing the tail per call as before — is what makes the LevelDB carve O(n) instead of O(n^2).
function extractBalanced(text, start, open, close, maxLen = MAX_LEVELDB_OBJECT_BYTES) {
  const limit = Math.min(text.length, start + maxLen);
  const openCode = open.charCodeAt(0);
  const closeCode = close.charCodeAt(0);
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < limit; i++) {
    const cc = text.charCodeAt(i);
    if (escape) { escape = false; continue; }
    if (cc === CC_BACKSLASH && inString) { escape = true; continue; }
    if (cc === CC_QUOTE) { inString = !inString; continue; }
    if (inString) continue;
    if (cc === openCode) depth++;
    else if (cc === closeCode) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseConversationItem(item, sourceFile, attribution) {
  const id = item.id != null ? String(item.id) : "";
  const title = item.title != null ? String(item.title) : "";
  const createTime = item.create_time != null ? String(item.create_time) : "";
  const updateTime = item.update_time != null ? String(item.update_time) : "";
  if (!id || (!title && !createTime)) return null;
  if (!id.includes("-") || id.length < 10) return null;

  const tsMs = parseChatgptTimestamp(createTime) ?? parseChatgptTimestamp(updateTime);
  if (tsMs == null) return null;

  const isArchived = !!item.is_archived;
  const gizmoId = item.gizmo_id != null ? String(item.gizmo_id) : "";
  let summary = title || `Conversation ${id}`;
  if (isArchived) summary = `${summary} [archived]`;
  const model = gizmoId ? `Custom GPT (${gizmoId})` : "";

  return makeRow({
    timestamp: formatTimestampUtc(tsMs),
    role: "conversation",
    recordType: "conversation",
    summary,
    sessionId: id,
    messageId: id,
    parentId: "",
    workspace: "",
    toolName: "",
    isSidechain: false,
    gitBranch: "",
    tool: TOOL_CHATGPT,
    model,
    sourceFile,
    user: attribution.user || "",
    host: attribution.host || "",
  }, TOOL_CHATGPT);
}

function extractFromLeveldbBytes(data, sourceFile, attribution, out) {
  const text = data.toString("latin1");
  const len = text.length;
  let capped = false;

  // Primary path: "items": [ ... ]. Scan for the colon/bracket in place within a small window
  // after the key (JSON puts them adjacent) instead of slicing the entire tail per match.
  let searchFrom = 0;
  let matches = 0;
  while (searchFrom < len) {
    const rel = text.indexOf('"items"', searchFrom);
    if (rel < 0) break;
    if (++matches > MAX_LEVELDB_MATCHES) { capped = true; break; }
    const keyEnd = rel + 7;
    searchFrom = keyEnd; // advance past this key unconditionally — never rescan it
    let p = keyEnd;
    while (p < len && p < keyEnd + 16 && isLeveldbWhitespace(text[p])) p++;
    if (text[p] !== ":") continue;
    p++;
    while (p < len && p < keyEnd + 48 && isLeveldbWhitespace(text[p])) p++;
    if (text[p] !== "[") continue;
    const arrJson = extractBalanced(text, p, "[", "]");
    if (!arrJson) continue;
    try {
      const items = JSON.parse(arrJson);
      if (Array.isArray(items)) {
        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          const row = parseConversationItem(item, sourceFile, attribution);
          if (row) out.push(row);
        }
      }
    } catch { /* skip malformed blob */ }
  }

  // Fallback path: standalone {...} objects carrying "create_time". Walk backward to the
  // enclosing '{' only within a bounded window (the metadata key sits near the object start),
  // so a buffer packed with the key but no brace cannot trigger an O(n) walk-to-zero per match.
  searchFrom = 0;
  matches = 0;
  while (searchFrom < len) {
    const rel = text.indexOf('"create_time"', searchFrom);
    if (rel < 0) break;
    if (++matches > MAX_LEVELDB_MATCHES) { capped = true; break; }
    searchFrom = rel + 13;
    const floor = Math.max(0, rel - LEVELDB_BACKSCAN_WINDOW);
    let start = rel;
    while (start > floor && text.charCodeAt(start) !== CC_OBRACE) start--;
    if (text.charCodeAt(start) !== CC_OBRACE) continue; // no enclosing object in window — bail
    const objJson = extractBalanced(text, start, "{", "}");
    if (!objJson) continue;
    try {
      const obj = JSON.parse(objJson);
      if (obj && typeof obj === "object") {
        const row = parseConversationItem(obj, sourceFile, attribution);
        if (row) out.push(row);
      }
    } catch { /* skip */ }
  }

  if (capped) {
    dbg("AIHIST", "leveldb match cap reached", { sourceFile, max: MAX_LEVELDB_MATCHES });
  }
}

function extractLeveldbFile(filePath, attribution) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_LEVELDB_BYTES) {
    dbg("AIHIST", "skip large leveldb file", { path: filePath, size: stat.size });
    return [];
  }
  const data = fs.readFileSync(filePath);
  const rows = [];
  extractFromLeveldbBytes(data, filePath, attribution, rows);
  return rows;
}

function copySqliteToTemp(dbPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "irflow-chatgpt-"));
  try {
    const base = path.basename(dbPath);
    const dest = path.join(tmpDir, base);
    fs.copyFileSync(dbPath, dest);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const aux = path.join(path.dirname(dbPath), `${base}${suffix}`);
      if (fs.existsSync(aux)) {
        try { fs.copyFileSync(aux, path.join(tmpDir, `${base}${suffix}`)); } catch { /* ignore */ }
      }
    }
    return dest;
  } catch (e) {
    // The primary copy can throw (source vanished mid-scan, EACCES, EIO). Reclaim the just-created
    // temp dir before rethrowing so a large triage scan does not accumulate orphaned dirs.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  }
}

function extractSqliteDatabase(dbPath, attribution) {
  let Database;
  try { Database = require("better-sqlite3"); } catch (e) {
    throw new Error("SQLite support unavailable (better-sqlite3 not loaded).");
  }

  const tmpDb = copySqliteToTemp(dbPath);
  const rows = [];
  let db;
  try {
    db = new Database(tmpDb, { readonly: true, fileMustExist: true });
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all().map((r) => r.name);

    const tableNames = tables.filter((t) => {
      const tl = t.toLowerCase();
      if (/meta|schema|migration|version|sqlite_/.test(tl)) return false;
      return /message|chat|conv|thread|turn|interaction|mapping|completion|prompt/.test(tl);
    });

    for (const table of tableNames) {
      const cols = db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all()
        .map((c) => c.name);
      const colLower = cols.map((c) => c.toLowerCase());

      const contentCol = cols.find((_, i) => /content|text|body|message_text|prompt|completion|parts/.test(colLower[i]));
      if (!contentCol) continue;

      const roleCol = cols.find((_, i) => /role|author|sender|speaker/.test(colLower[i]));
      const timeCol = cols.find((_, i) => /time|date|created|updated|timestamp/.test(colLower[i]));
      const modelCol = cols.find((_, i) => colLower[i].includes("model"));
      const sessionCol = cols.find((_, i) => /conversation|session|chat_id|thread/.test(colLower[i]));

      const selectCols = ["rowid", contentCol];
      if (roleCol) selectCols.push(roleCol);
      if (timeCol) selectCols.push(timeCol);
      if (modelCol) selectCols.push(modelCol);
      if (sessionCol) selectCols.push(sessionCol);

      const sql = `SELECT ${selectCols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ")} FROM "${table.replace(/"/g, '""')}"`;
      let stmt;
      try { stmt = db.prepare(sql); } catch { continue; }

      for (const rec of stmt.iterate()) {
        const content = rec[contentCol] != null ? String(rec[contentCol]) : "";
        if (!content.trim()) continue;
        const role = roleCol && rec[roleCol] != null ? String(rec[roleCol]) : "unknown";
        const tsMs = timeCol ? parseChatgptTimestamp(rec[timeCol]) : null;
        if (tsMs == null) continue;
        rows.push(makeRow({
          timestamp: formatTimestampUtc(tsMs),
          role: role || "unknown",
          recordType: "message",
          summary: content,
          sessionId: sessionCol && rec[sessionCol] != null ? String(rec[sessionCol]) : "",
          messageId: String(rec.rowid),
          parentId: "",
          workspace: "",
          toolName: "",
          isSidechain: false,
          gitBranch: "",
          tool: TOOL_CHATGPT,
          model: modelCol && rec[modelCol] != null ? String(rec[modelCol]) : "",
          sourceFile: dbPath,
          user: attribution.user || "",
          host: attribution.host || "",
        }, TOOL_CHATGPT));
      }
    }
  } finally {
    if (db) try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return rows;
}

function detectEncryptedConversationBundles(appDir, maxDepth = 10) {
  const hits = [];
  if (!appDir || !fs.existsSync(appDir)) return hits;
  const stack = [{ d: appDir, depth: 0 }];
  while (stack.length) {
    const { d, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < maxDepth) stack.push({ d: full, depth: depth + 1 });
      else if (e.isFile() && /^conversations-v2/i.test(e.name)) hits.push(full);
    }
  }
  return hits;
}

function buildChatgptExtractionStats(rows, appDir = null, precomputedBundles = null) {
  let conversationCount = 0;
  let messageCount = 0;
  for (const r of rows) {
    if (r.RecordType === "conversation") conversationCount += 1;
    else if (r.RecordType === "message") messageCount += 1;
  }
  const leveldbMetadataOnly = conversationCount > 0 && messageCount === 0;
  const encryptedBundles = precomputedBundles
    || (appDir ? detectEncryptedConversationBundles(appDir) : []);
  return {
    conversationCount,
    messageCount,
    leveldbMetadataOnly,
    encryptedBundleCount: encryptedBundles.length,
    encryptedBundleSample: encryptedBundles.slice(0, 3),
  };
}

function formatChatgptImportNotice(stats) {
  if (!stats) return "";
  const { conversationCount, messageCount, leveldbMetadataOnly, encryptedBundleCount } = stats;
  if (encryptedBundleCount > 0 && messageCount === 0) {
    return `ChatGPT: found ${encryptedBundleCount} encrypted conversations-v2 bundle(s) (Keychain-gated on macOS) — IRFlow cannot decrypt these; LevelDB/SQLite may only have titles.`;
  }
  if (encryptedBundleCount > 0 && messageCount > 0) {
    return `ChatGPT: ${messageCount} message(s) from SQLite; ${encryptedBundleCount} encrypted conversations-v2 bundle(s) on disk are not decrypted (Keychain-gated on macOS).`;
  }
  if (leveldbMetadataOnly) {
    return `ChatGPT: ${conversationCount} conversation(s) from LevelDB metadata; no message bodies found in SQLite — open the app or check for a messages database.`;
  }
  if (messageCount > 0) {
    return `ChatGPT: ${messageCount} message(s)${conversationCount ? `, ${conversationCount} conversation header(s)` : ""}.`;
  }
  return `ChatGPT: ${conversationCount || messageCount} row(s) imported.`;
}

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const key = `${r.SessionId}:${r.Timestamp}:${r.Role}:${r.Summary.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function walkChatgptFiles(appDir, onFile) {
  const stack = [appDir];
  let depth = 0;
  while (stack.length && depth < 12) {
    const levelSize = stack.length;
    for (let i = 0; i < levelSize; i++) {
      const d = stack.shift();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) onFile(full);
      }
    }
    depth++;
  }
}

function isChatgptDataFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  if ((ext === ".ldb" || ext === ".log") && isInLeveldbDir(filePath)) return true;
  if (ext === ".db" || ext === ".sqlite" || ext === ".sqlite3") return true;
  if (!ext && !base.endsWith("-wal") && !base.endsWith("-shm") && isSqliteFile(filePath)) return true;
  return false;
}

function listChatgptDataFiles(appDir) {
  const files = [];
  walkChatgptFiles(appDir, (filePath) => {
    if (isChatgptDataFile(filePath)) files.push(filePath);
  });
  return files;
}

function extractChatgptDataFile(filePath, attribution) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  if ((ext === ".ldb" || ext === ".log") && isInLeveldbDir(filePath)) {
    return extractLeveldbFile(filePath, attribution);
  }
  if (ext === ".db" || ext === ".sqlite" || ext === ".sqlite3") {
    return extractSqliteDatabase(filePath, attribution);
  }
  if (!ext && !base.endsWith("-wal") && !base.endsWith("-shm") && isSqliteFile(filePath)) {
    return extractSqliteDatabase(filePath, attribution);
  }
  return [];
}

/**
 * Extract timeline rows from a ChatGPT Desktop application data directory.
 */
async function extractChatgptDir(appDir, attribution = {}, options = {}) {
  const rows = [];
  const dataFiles = listChatgptDataFiles(appDir);
  const fileCount = dataFiles.length;
  const { onFileProgress, onExtractedRows } = options;
  let streamConversationCount = 0;
  let streamMessageCount = 0;

  for (let i = 0; i < dataFiles.length; i++) {
    const filePath = dataFiles[i];
    tickFileProgress(onFileProgress, i + 1, fileCount, filePath);
    try {
      const fileRows = extractChatgptDataFile(filePath, attribution);
      if (onExtractedRows && fileRows.length) {
        for (const r of fileRows) {
          if (r.RecordType === "conversation") streamConversationCount += 1;
          else if (r.RecordType === "message") streamMessageCount += 1;
        }
        onExtractedRows(fileRows);
      } else {
        rows.push(...fileRows);
      }
    } catch (e) {
      dbg("AIHIST", "chatgpt file extract failed", { filePath, err: e.message });
    }
    if ((i + 1) % 12 === 0) await new Promise((r) => setImmediate(r));
  }

  const encryptedBundles = detectEncryptedConversationBundles(appDir);
  const bundleRows = [];
  for (const bundlePath of encryptedBundles) {
    let mtime = "";
    try { mtime = formatTimestampUtc(fs.statSync(bundlePath).mtimeMs); } catch { /* ignore */ }
    bundleRows.push(makeRow({
      timestamp: mtime,
      role: "system",
      recordType: "encrypted_bundle",
      summary: `Encrypted ChatGPT bundle (not decrypted): ${path.basename(bundlePath)}`,
      sessionId: "",
      messageId: "",
      parentId: "",
      workspace: path.dirname(bundlePath),
      toolName: TOOL_CHATGPT,
      sourceFile: bundlePath,
      user: attribution.user || "",
      host: attribution.host || "",
      description: "conversations-v2-* requires macOS Keychain; metadata-only row for counsel inventory",
    }, TOOL_CHATGPT));
  }
  if (bundleRows.length) {
    if (onExtractedRows) onExtractedRows(bundleRows);
    else rows.push(...bundleRows);
  }

  if (onExtractedRows) {
    const out = [];
    out._chatgptStats = {
      conversationCount: streamConversationCount,
      messageCount: streamMessageCount,
      leveldbMetadataOnly: streamConversationCount > 0 && streamMessageCount === 0,
      encryptedBundleCount: encryptedBundles.length,
      encryptedBundleSample: encryptedBundles.slice(0, 3),
    };
    return out;
  }

  const sorted = finalizeAiHistoryRows(dedupeRows(rows), options);
  sorted._chatgptStats = buildChatgptExtractionStats(sorted, appDir, encryptedBundles);
  return sorted;
}

/** Shallow probe for profile discovery (no deep tree walk). */
function isChatgptAppDirQuick(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return false;
  try {
    if (!fs.statSync(dirPath).isDirectory()) return false;
  } catch { return false; }
  const hints = [
    path.join(dirPath, "Local Storage", "leveldb"),
    path.join(dirPath, "IndexedDB"),
    path.join(dirPath, "databases"),
    path.join(dirPath, "conversations.db"),
  ];
  for (const h of hints) {
    if (fs.existsSync(h)) return true;
  }
  return false;
}

function isChatgptAppDir(dirPath, { quick = false } = {}) {
  if (!dirPath || !fs.existsSync(dirPath)) return false;
  try {
    if (!fs.statSync(dirPath).isDirectory()) return false;
  } catch { return false; }
  if (quick) return isChatgptAppDirQuick(dirPath);

  const name = path.basename(dirPath);
  const lower = dirPath.toLowerCase();
  const nameMatch = name === "com.openai.chat"
    || name === "Atlas"
    || name === "ChatGPT"
    || name === "chat.openai.com"
    || name.startsWith("OpenAI.ChatGPT")
    || /^openai\.chatgpt/i.test(name);

  const pathMatch = /packages[\\/]openai\.chatgpt/i.test(lower)
    || lower.includes("com.openai.chat")
    || (lower.includes("localcache") && lower.includes("openai"));

  if (!nameMatch && !pathMatch && !lower.includes("chatgpt") && !lower.includes("openai")) return false;

  let found = false;
  walkChatgptFiles(dirPath, (filePath) => {
    if (found) return;
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".ldb" || ext === ".log" || ext === ".db" || ext === ".sqlite" || ext === ".sqlite3") {
      found = true;
      return;
    }
    if (!ext && isSqliteFile(filePath)) found = true;
  });
  return found;
}

function resolveChatgptDir(target) {
  if (!target) return null;
  if (isChatgptAppDir(target)) return target;
  const base = path.basename(target);
  if (base === "ChatGPT" || base === "com.openai.chat" || base === "Atlas") {
    const parent = path.dirname(target);
    if (isChatgptAppDir(parent)) return parent;
  }
  return isChatgptAppDir(target) ? target : null;
}

async function extractChatgptPath(target, attribution = {}, options = {}) {
  if (!target || !fs.existsSync(target)) {
    throw new Error(`Path does not exist: ${target}`);
  }

  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const appDir = resolveChatgptDir(target) || target;
    if (!isChatgptAppDir(appDir)) {
      throw new Error("Not a ChatGPT Desktop data directory (no LevelDB/SQLite stores found).");
    }
    return extractChatgptDir(appDir, attribution, options);
  }

  if (stat.isFile()) {
    const ext = path.extname(target).toLowerCase();
    const rows = [];
    if ((ext === ".ldb" || ext === ".log") && isInLeveldbDir(target)) {
      rows.push(...extractLeveldbFile(target, attribution));
    } else if (ext === ".db" || ext === ".sqlite" || ext === ".sqlite3" || isSqliteFile(target)) {
      rows.push(...extractSqliteDatabase(target, attribution));
    } else {
      throw new Error("Expected a ChatGPT LevelDB (.ldb) or SQLite database file.");
    }
    return finalizeAiHistoryRows(dedupeRows(rows), options);
  }

  throw new Error("Expected a ChatGPT data directory or database file.");
}

module.exports = {
  extractChatgptDir,
  extractChatgptPath,
  isChatgptAppDir,
  isChatgptAppDirQuick,
  resolveChatgptDir,
  parseChatgptTimestamp,
  parseConversationItem,
  extractFromLeveldbBytes,
  extractLeveldbFile,
  extractSqliteDatabase,
  isSqliteFile,
  isInLeveldbDir,
  buildChatgptExtractionStats,
  formatChatgptImportNotice,
  detectEncryptedConversationBundles,
};
