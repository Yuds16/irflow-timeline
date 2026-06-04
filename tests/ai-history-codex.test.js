"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  stripCodexUserText,
  parseCodexHistoryLine,
  parseRolloutEnvelope,
  isCodexForkedSession,
  extractCodexDir,
  isCodexDir,
  resolveCodexHome,
} = require("../electron/parsers/ai-history/codex");
const { filterSidechainRows } = require("../electron/parsers/ai-history/extract-plan");
const { detectAiHistoryImport, planImportPaths } = require("../electron/parsers/ai-history-import");

const FIXTURE_CODEX = path.join(__dirname, "fixtures/ai-history/codex/.codex");

test("stripCodexUserText extracts IDE prompt block", () => {
  const raw = "## My request for Codex:\nrun strings on sample.bin\n";
  assert.equal(stripCodexUserText(raw), "run strings on sample.bin");
  assert.equal(stripCodexUserText("<environment_context></environment_context>"), "");
});

test("parseCodexHistoryLine uses session_id and RecordType history", () => {
  const row = parseCodexHistoryLine(
    { session_id: "s1", ts: 1704067200, text: "hello codex" },
    "/home/u/.codex/history.jsonl",
    { user: "u" },
  );
  assert.ok(row);
  assert.equal(row.RecordType, "history");
  assert.equal(row.Tool, "OpenAI Codex");
  assert.equal(row.InvokedTool, "");
  assert.equal(row.SessionId, "s1");
});

test("isCodexForkedSession detects parent_session_id", () => {
  assert.equal(isCodexForkedSession({ id: "child", parent_session_id: "parent-1" }), true);
  assert.equal(isCodexForkedSession({ id: "main" }), false);
});

test("parseRolloutEnvelope marks forked sessions as sidechain", () => {
  const ctx = { sessionId: "", workspace: "", model: "", threadIndex: new Map(), isSidechainSession: false };
  parseRolloutEnvelope({
    type: "session_meta",
    timestamp: "2026-01-01T12:00:00.000Z",
    payload: { id: "child", parent_session_id: "parent-1", cwd: "/proj" },
  }, "rollout.jsonl", ctx, {});
  assert.equal(ctx.isSidechainSession, true);

  const user = parseRolloutEnvelope({
    type: "event_msg",
    timestamp: "2026-01-01T12:00:01.000Z",
    payload: { type: "user_message", message: "forked prompt" },
  }, "rollout.jsonl", ctx, {});
  assert.equal(user.IsSidechain, "true");
  const mainOnly = filterSidechainRows([user], {});
  assert.equal(mainOnly.length, 0);
});

test("parseRolloutEnvelope handles messages and function_call", () => {
  const ctx = { sessionId: "", workspace: "", model: "", threadIndex: new Map(), isSidechainSession: false };
  const meta = parseRolloutEnvelope({
    type: "session_meta",
    timestamp: "2026-01-01T12:00:00.000Z",
    payload: { id: "s1", cwd: "/proj", cli_version: "1.0" },
  }, "rollout.jsonl", ctx, {});
  assert.ok(meta);
  assert.equal(ctx.sessionId, "s1");

  const user = parseRolloutEnvelope({
    type: "event_msg",
    timestamp: "2026-01-01T12:00:01.000Z",
    payload: { type: "user_message", message: "## My request for Codex:\ndo work\n" },
  }, "rollout.jsonl", ctx, {});
  assert.equal(user.Role, "user");
  assert.equal(user.Summary, "do work");

  const tool = parseRolloutEnvelope({
    type: "response_item",
    timestamp: "2026-01-01T12:00:02.000Z",
    payload: { type: "function_call", name: "shell", arguments: "{}", call_id: "c1" },
  }, "rollout.jsonl", ctx, {});
  assert.equal(tool.RecordType, "function_call");
  assert.equal(tool.InvokedTool, "shell");
});

test("extractCodexDir reads fixture history and rollout", async () => {
  assert.ok(isCodexDir(FIXTURE_CODEX));
  const rows = await extractCodexDir(FIXTURE_CODEX, { user: "analyst", host: "HOST1" });
  assert.ok(rows.length >= 4, `expected several rows, got ${rows.length}`);
  assert.ok(rows.some((r) => r.RecordType === "function_call"));
  assert.ok(rows.some((r) => r.Summary.includes("static analysis")));
  const deduped = rows.filter((r) => r.RecordType === "history");
  assert.equal(deduped.length, 0, "history row deduped when session has same prompt");
});

test("detectAiHistoryImport and planImportPaths recognize .codex", () => {
  assert.equal(detectAiHistoryImport(FIXTURE_CODEX)?.tool, "codex");
  assert.equal(resolveCodexHome(FIXTURE_CODEX), FIXTURE_CODEX);
  const rollout = path.join(FIXTURE_CODEX, "sessions/2026/01/01/rollout-test-fixture.jsonl");
  const planned = planImportPaths([rollout, path.join(FIXTURE_CODEX, "history.jsonl")]);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].opts.aiHistoryTool, "codex");
});
