"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  supplementCodexFromStateSqlite,
  buildCodexStateSqliteNotice,
} = require("../electron/parsers/ai-history/codex-state-sqlite");

test("supplementCodexFromStateSqlite reads thread metadata table", () => {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (e) {
    if (e.code === "ERR_DLOPEN_FAILED") return;
    throw e;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "irflow-codex-sqlite-"));
  const codexRoot = path.join(tmp, ".codex");
  fs.mkdirSync(codexRoot, { recursive: true });
  const dbPath = path.join(codexRoot, "state.sqlite");
  let db;
  try {
    db = new Database(dbPath);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (e.code === "ERR_DLOPEN_FAILED") return;
    throw e;
  }
  db.exec(`CREATE TABLE threads (thread_id TEXT, title TEXT, updated_at TEXT);
    INSERT INTO threads VALUES ('t-1', 'Deploy script', '2024-01-15T12:00:00Z');`);
  db.close();

  const { rows, stats } = supplementCodexFromStateSqlite(codexRoot, { user: "alice", host: "HOST" });
  assert.ok(stats?.indexRows >= 1);
  const threadRow = rows.find((r) => r.RecordType === "thread_index" && /Deploy script/.test(r.Summary));
  assert.ok(threadRow);
  assert.equal(threadRow.Timestamp, "2024-01-15 12:00:00");
  assert.equal(buildCodexStateSqliteNotice(stats).includes("state.sqlite"), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});
