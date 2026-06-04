"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  parseDesktopMetadataFile,
  normalizeCliSessionId,
  resolveClaudeProjectsDir,
  extractClaudeDesktopDir,
  buildClaudeDesktopImportNotice,
} = require("../electron/parsers/ai-history/claude-desktop");
const { extractClaudeDir } = require("../electron/parsers/ai-history/claude-code");

const FIXTURE_DESKTOP = path.join(__dirname, "fixtures/ai-history/claude-desktop/claude-code-sessions");
const FIXTURE_ROOT = path.join(__dirname, "fixtures/ai-history/claude-desktop");

test("normalizeCliSessionId reads cliSessionId and local_ sessionId fallback", () => {
  assert.equal(normalizeCliSessionId({ cliSessionId: "sess-abc" }), "sess-abc");
  assert.equal(normalizeCliSessionId({ sessionId: "local_uuid-here" }), "uuid-here");
});

test("resolveClaudeProjectsDir finds sibling .claude/projects", () => {
  const projects = resolveClaudeProjectsDir(FIXTURE_DESKTOP);
  assert.ok(projects);
  assert.match(projects, /[\\/]\.claude[\\/]projects$/);
});

test("extractClaudeDesktopDir links metadata to JSONL transcripts", async () => {
  const { rows, stats } = await extractClaudeDesktopDir(FIXTURE_DESKTOP, { user: "testuser" });
  assert.ok(stats.linkedTranscripts >= 1);
  assert.ok(rows.length >= 2);
  const userRow = rows.find((r) => r.MessageId === "msg-user-1");
  assert.ok(userRow);
  assert.equal(userRow.User, "testuser");
});

test("extractClaudeDir routes Desktop sessions root to desktop extractor", async () => {
  const rows = await extractClaudeDir(FIXTURE_DESKTOP, { user: "u1" });
  assert.ok(rows._claudeDesktopStats);
  assert.ok(rows.length >= 2);
});

test("buildClaudeDesktopImportNotice warns on dangling cliSessionId", () => {
  const msg = buildClaudeDesktopImportNotice({ metadataFiles: 2, linkedTranscripts: 0, danglingCli: 2 });
  assert.match(msg, /missing/i);
});
