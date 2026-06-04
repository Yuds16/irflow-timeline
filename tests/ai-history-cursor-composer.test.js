"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("fs");
const os = require("os");

const { extractCursorComposerStores } = require("../electron/parsers/ai-history/cursor-composer");
const { buildCursorComposerFixture } = require("./helpers/vscdb-builder");

const FIXTURE_CURSOR = path.join(__dirname, "fixtures/ai-history/cursor/.cursor");

test("extractCursorComposerStores reads bubble messages from state.vscdb", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "irflow-cursor-vscdb-"));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  const userDir = path.join(tmp, "Library", "Application Support", "Cursor", "User");
  const globalDb = path.join(userDir, "globalStorage", "state.vscdb");
  if (!buildCursorComposerFixture(globalDb)) {
    t.skip("better-sqlite3 not available in this Node runtime");
    return;
  }

  const agentHome = path.join(tmp, ".cursor");
  fs.mkdirSync(path.join(agentHome, "projects"), { recursive: true });

  const { rows, stats } = await extractCursorComposerStores(agentHome, { user: "analyst" }, {
    userDataDirs: [userDir],
  });
  assert.ok(stats.databases >= 1);
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].Tool, "Cursor");
  assert.match(rows.find((r) => r.Role === "user")?.Summary || "", /composer DB/);
});

test("extractCursorDir merges transcript and composer rows when vscdb present", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "irflow-cursor-merge-"));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  const globalDb = path.join(tmp, "globalStorage", "state.vscdb");
  if (!buildCursorComposerFixture(globalDb)) {
    t.skip("better-sqlite3 not available in this Node runtime");
    return;
  }

  const { extractCursorDir } = require("../electron/parsers/ai-history/cursor");
  const rows = await extractCursorDir(FIXTURE_CURSOR, { user: "u" });
  assert.ok(rows.length >= 2);
});
