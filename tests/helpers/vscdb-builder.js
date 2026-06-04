"use strict";

const fs = require("fs");
const path = require("path");

function buildCursorComposerFixture(dbPath) {
  let Database;
  try {
    Database = require("better-sqlite3");
    // Probe load — may be built for Electron ABI, not plain Node test runner.
    const probe = path.join(require("os").tmpdir(), `irflow-sqlite-probe-${process.pid}.db`);
    const d = new Database(probe);
    d.close();
    try { fs.unlinkSync(probe); } catch { /* ignore */ }
  } catch (e) {
    if (e.code === "ERR_DLOPEN_FAILED") return false;
    throw e;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  `);

  const composerId = "fda95e1a-7d3a-4113-942f-7e033e454bef";
  const bubbleUser = "7dd300cc-6205-47ab-913e-fc921e68cef9";
  const bubbleAsst = "8ee411dd-7316-58bc-a24f-gd032e79df0a";

  const composerData = {
    composerId,
    createdAt: 1704067200000,
    lastUpdatedAt: 1704067260000,
    fullConversationHeadersOnly: [
      { bubbleId: bubbleUser, type: 1 },
      { bubbleId: bubbleAsst, type: 2 },
    ],
  };

  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    `composerData:${composerId}`,
    JSON.stringify(composerData),
  );
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    `bubbleId:${composerId}:${bubbleUser}`,
    JSON.stringify({ type: 1, text: "Hello from composer DB", createdAt: 1704067200000 }),
  );
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    `bubbleId:${composerId}:${bubbleAsst}`,
    JSON.stringify({ type: 2, text: "Reply from composer DB", createdAt: 1704067260000 }),
  );
  db.close();
  return true;
}

module.exports = { buildCursorComposerFixture };
