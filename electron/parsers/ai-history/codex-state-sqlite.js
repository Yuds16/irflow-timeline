/**
 * codex-state-sqlite.js — supplemental thread metadata from Codex state.sqlite (index-only).
 */

const fs = require("fs");
const path = require("path");

const { dbg } = require("../../logger");
const { openVscdbReadOnly, listTables, safeCloseDb } = require("./vscdb-kv");
const { TOOL_CODEX } = require("./schema");
const { formatTimestampUtc, parseIsoTimestamp, makeRow, sortAndNumberRows } = require("./row-utils");

/** Parse epoch-seconds, epoch-ms, or ISO strings to epoch ms. */
function parseFlexibleTimestamp(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n > 1e12 ? n : (n > 1e9 ? n * 1000 : n);
  }
  return parseIsoTimestamp(s);
}

function codexMetaRow(fields) {
  return makeRow({ ...fields, tool: TOOL_CODEX, role: fields.role || "system", recordType: fields.recordType || "thread_index" }, TOOL_CODEX);
}

function pickString(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

function parseMaybeJson(val) {
  if (val == null) return null;
  if (Buffer.isBuffer(val)) val = val.toString("utf8");
  if (typeof val !== "string") return val;
  const t = val.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return t; }
}

function rowFromThreadRecord(rec, sourceFile, attribution) {
  const title = pickString(rec, ["title", "name", "subject", "summary", "displayName", "thread_title"]);
  const sessionId = pickString(rec, ["session_id", "sessionId", "thread_id", "threadId", "id", "uuid"]);
  const tsRaw = pickString(rec, ["updated_at", "updatedAt", "created_at", "createdAt", "ts", "timestamp", "last_message_at"]);
  const tsMs = parseFlexibleTimestamp(tsRaw);
  const ts = tsMs != null ? formatTimestampUtc(tsMs) : "";
  const summary = title
    ? `Codex thread index: ${title}`
    : sessionId
      ? `Codex thread index: ${sessionId}`
      : "Codex thread index entry (state.sqlite)";
  return codexMetaRow({
    timestamp: ts,
    role: "system",
    recordType: "thread_index",
    summary,
    sessionId,
    messageId: "",
    parentId: "",
    workspace: "",
    toolName: "",
    sourceFile,
    user: attribution.user || "",
    host: attribution.host || "",
    description: "Codex state.sqlite metadata (not full rollout transcript)",
  });
}

function extractRowsFromTable(db, tableName, sourceFile, attribution, maxRows) {
  const rows = [];
  let columns;
  try {
    columns = db.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => c.name);
  } catch {
    return rows;
  }
  const colLower = columns.map((c) => c.toLowerCase());
  const hasThreadHint = colLower.some((c) => /thread|session|title|conversation/.test(c));
  if (!hasThreadHint) return rows;

  let records;
  try {
    records = db.prepare(`SELECT * FROM "${tableName.replace(/"/g, "")}" LIMIT ${maxRows}`).all();
  } catch {
    return rows;
  }

  for (const rec of records) {
    const row = rowFromThreadRecord(rec, sourceFile, attribution);
    if (row.SessionId || (row.Summary && !row.Summary.endsWith("(state.sqlite)"))) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * @returns {{ rows: object[], stats: { databases: number, indexRows: number }|null }}
 */
function supplementCodexFromStateSqlite(codexRoot, attribution = {}, options = {}) {
  const dbPath = path.join(codexRoot, "state.sqlite");
  if (!fs.existsSync(dbPath)) {
    return { rows: [], stats: null };
  }

  const maxRows = options.maxIndexRows ?? 500;
  const rows = [];
  let db;
  try {
    db = openVscdbReadOnly(dbPath);
    for (const table of listTables(db)) {
      if (rows.length >= maxRows) break;
      try {
        rows.push(...extractRowsFromTable(db, table, dbPath, attribution, maxRows - rows.length));
      } catch (e) {
        dbg("AIHIST", "codex state.sqlite table skipped", { table, err: e.message });
      }
    }

    // ItemTable / KV style (VS Code family)
    try {
      const itemRows = db.prepare(
        "SELECT key, value FROM ItemTable WHERE key LIKE '%thread%' OR key LIKE '%session%' OR key LIKE '%codex%' LIMIT 200",
      ).all();
      for (const { key, value } of itemRows) {
        const parsed = parseMaybeJson(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const row = rowFromThreadRecord({ ...parsed, title: parsed.title || key }, dbPath, attribution);
          if (row.Summary) rows.push(row);
        }
      }
    } catch { /* no ItemTable */ }
  } catch (e) {
    dbg("AIHIST", "codex state.sqlite open failed", { dbPath, err: e.message });
    return { rows: [], stats: null };
  } finally {
    safeCloseDb(db);
  }

  // Single-pass Set dedupe (keep first occurrence in sorted order) — the prior findIndex-in-filter was
  // O(n^2) over the index rows (~250k comparisons at 500 rows).
  const seen = new Set();
  const unique = sortAndNumberRows(rows).filter((r) => {
    const k = `${r.SessionId}:${r.Summary.slice(0, 60)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    rows: unique,
    stats: unique.length
      ? { databases: 1, indexRows: unique.length, source: dbPath }
      : null,
  };
}

function buildCodexStateSqliteNotice(stats) {
  if (!stats?.indexRows) return "";
  return `OpenAI Codex: +${stats.indexRows} thread index row(s) from state.sqlite (metadata; full text remains in rollout JSONL when collected).`;
}

module.exports = {
  supplementCodexFromStateSqlite,
  buildCodexStateSqliteNotice,
};
