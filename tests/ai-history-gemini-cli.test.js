"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  extractGeminiSessionFile,
  extractGeminiLogsFile,
  extractGeminiCliDir,
  extractGeminiCliPath,
  isGeminiCliRoot,
  isGeminiSessionFile,
  isGeminiLogsFile,
  countGeminiSessions,
} = require("../electron/parsers/ai-history/gemini-cli");

const FIXTURE_GEMINI = path.join(__dirname, "fixtures/ai-history/gemini/.gemini");
const FIXTURE_GEMINI_LOGS = path.join(__dirname, "fixtures/ai-history/gemini-logs/.gemini");
const FIXTURE_SESSION = path.join(FIXTURE_GEMINI, "tmp/a1b2c3d4/chats/session-demo.json");
const FIXTURE_LOGS = path.join(FIXTURE_GEMINI_LOGS, "tmp/deadbeefcafe/logs.json");

test("isGeminiSessionFile recognizes chats/session-*.json paths", () => {
  assert.ok(isGeminiSessionFile(FIXTURE_SESSION));
  assert.ok(!isGeminiSessionFile("/tmp/session-demo.json"));
});

test("extractGeminiSessionFile parses user and gemini messages", () => {
  const rows = extractGeminiSessionFile(FIXTURE_SESSION, { user: "analyst" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Role, "user");
  assert.equal(rows[0].User, "analyst");
  assert.equal(rows[0].Tool, "Gemini CLI");
  assert.equal(rows[1].Role, "assistant");
  assert.equal(rows[1].Model, "gemini-2.0-flash");
  assert.equal(rows[1].InputTokens, "42");
  assert.match(rows[1].Summary, /Reasoning present/);
  assert.equal(rows[0].SessionId, "sess-gemini-demo-1");
  assert.equal(rows[0].Workspace, "deadbeef");
});

test("extractGeminiCliDir reads all sessions under .gemini/tmp", async () => {
  const rows = await extractGeminiCliDir(FIXTURE_GEMINI, { host: "HOST1" });
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => r.RecordId));
  assert.equal(rows[0].Host, "HOST1");
});

test("isGeminiCliRoot and countGeminiSessions", () => {
  assert.ok(isGeminiCliRoot(FIXTURE_GEMINI));
  assert.ok(countGeminiSessions(FIXTURE_GEMINI) >= 1);
});

test("extractGeminiCliPath accepts a single session file", async () => {
  const rows = await extractGeminiCliPath(FIXTURE_SESSION);
  assert.equal(rows.length, 2);
});

test("isGeminiLogsFile and extractGeminiLogsFile parse tmp/logs.json", () => {
  assert.ok(isGeminiLogsFile(FIXTURE_LOGS));
  assert.ok(!isGeminiLogsFile(FIXTURE_SESSION));
  const rows = extractGeminiLogsFile(FIXTURE_LOGS);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Role, "user");
  assert.match(rows[0].Summary, /open ports/);
  assert.equal(rows[1].Role, "assistant");
  assert.equal(rows[0].SessionId, "sess-logs-demo-1");
});

test("extractGeminiCliDir reads legacy logs.json under .gemini/tmp", async () => {
  assert.ok(isGeminiCliRoot(FIXTURE_GEMINI_LOGS));
  const rows = await extractGeminiCliDir(FIXTURE_GEMINI_LOGS);
  assert.equal(rows.length, 2);
  assert.equal(countGeminiSessions(FIXTURE_GEMINI_LOGS), 1);
});

test("extractGeminiSessionFile includes system and error message types", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "irflow-gemini-"));
  const chats = path.join(tmp, "chats");
  fs.mkdirSync(chats, { recursive: true });
  const sessionPath = path.join(chats, "session-syserr.json");
  fs.writeFileSync(sessionPath, JSON.stringify({
    sessionId: "s-err",
    projectHash: "abc",
    startTime: "2026-03-01T12:00:00.000Z",
    messages: [
      { type: "system", content: "System prompt", timestamp: "2026-03-01T12:00:01.000Z" },
      { type: "error", error: "Rate limited", timestamp: "2026-03-01T12:00:02.000Z" },
    ],
  }));
  const rows = extractGeminiSessionFile(sessionPath);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Role, "system");
  assert.equal(rows[1].RecordType, "error");
  assert.match(rows[1].Summary, /Rate limited/);
  assert.equal(rows[0].LineNumber, "1");
  fs.rmSync(tmp, { recursive: true, force: true });
});
