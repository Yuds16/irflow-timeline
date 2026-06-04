"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { scanAiArtifacts, extractUsername, classifyChatgptDir } = require("../electron/parsers/ai-artifacts");

test("extractUsername parses Windows and macOS profile paths", () => {
  assert.equal(extractUsername("/Users/bradleyroughan/.claude/history.jsonl"), "bradleyroughan");
  assert.equal(extractUsername("C:\\Users\\Administrator\\.claude\\history.jsonl"), "Administrator");
  assert.equal(extractUsername("/home/analyst/.claude"), "analyst");
  assert.equal(extractUsername("/Users/Public/.claude"), "");
});

test("scanAiArtifacts finds .claude directories in a triage tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "irflow-ai-scan-"));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const claudeDir = path.join(root, "C", "Users", "jsmith", ".claude");
  fs.mkdirSync(path.join(claudeDir, "projects", "app"), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "history.jsonl"), '{"display":"hi","timestamp":1,"sessionId":"s"}\n');
  fs.writeFileSync(path.join(claudeDir, "projects", "app", "s1.jsonl"), "");

  const scan = scanAiArtifacts(root);
  assert.ok(Array.isArray(scan.browserAgentHints));
  assert.equal(scan.claudeCode.length, 1);
  assert.ok(scan.claudeCode[0].path.endsWith(".claude"));
  assert.equal(scan.claudeCode[0].username, "jsmith");
});

test("scanAiArtifacts finds ChatGPT Desktop app data folders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "irflow-ai-chatgpt-scan-"));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const chatDir = path.join(
    root, "C", "Users", "alice", "AppData", "Roaming", "OpenAI", "ChatGPT",
  );
  fs.mkdirSync(path.join(chatDir, "Local Storage", "leveldb"), { recursive: true });
  fs.writeFileSync(
    path.join(chatDir, "Local Storage", "leveldb", "000001.ldb"),
    Buffer.from('x{"items":[{"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","title":"Triage chat","create_time":"2026-01-15T08:00:00.000Z"}]}'),
  );

  const scan = scanAiArtifacts(root);
  assert.equal(scan.chatgpt.length, 1);
  assert.equal(scan.chatgpt[0].username, "alice");
  assert.ok(classifyChatgptDir(scan.chatgpt[0].path));
});

test("scanAiArtifacts finds Gemini CLI .gemini directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "irflow-ai-gemini-scan-"));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const geminiDir = path.join(root, "home", "dev", ".gemini", "tmp", "hash1", "chats");
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "fixtures/ai-history/gemini/.gemini/tmp/a1b2c3d4/chats/session-demo.json"),
    path.join(geminiDir, "session-copy.json"),
  );

  const scan = scanAiArtifacts(root);
  assert.equal(scan.geminiCli.length, 1);
  assert.equal(scan.geminiCli[0].username, "dev");
  assert.ok(scan.geminiCli[0].sessionCount >= 1);
});

test("scanAiArtifacts finds VS Code Copilot workspaceStorage on Windows layout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "irflow-ai-copilot-scan-"));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const wsStorage = path.join(
    root, "C", "Users", "analyst", "AppData", "Roaming", "Code", "User", "workspaceStorage",
  );
  const chatDir = path.join(wsStorage, "abc123def456", "chatSessions");
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(
    path.join(chatDir, "sess-1.json"),
    '{"version":2,"requests":[],"sessionId":"s1","creationDate":1,"lastMessageDate":2}',
  );

  const scan = scanAiArtifacts(root);
  assert.equal(scan.copilot.length, 1);
  assert.equal(path.basename(scan.copilot[0].path), "workspaceStorage");
  assert.equal(scan.copilot[0].username, "analyst");
});

test("scanAiArtifacts collects browser hints in the same walk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "irflow-browser-hint-"));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const chrome = path.join(root, "Users", "alice", "AppData", "Local", "Google", "Chrome", "Default", "IndexedDB");
  fs.mkdirSync(chrome, { recursive: true });

  const scan = scanAiArtifacts(root, { maxDepth: 16 });
  assert.ok(scan.browserAgentHints.length >= 1);
  assert.ok(scan.browserAgentHints.some((h) => h.id === "chrome-claude"));
});

test("scanAiArtifacts finds OpenAI Codex .codex directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "irflow-ai-codex-scan-"));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const codexDir = path.join(root, "Users", "bob", ".codex");
  const sessions = path.join(codexDir, "sessions", "2026", "01", "01");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "history.jsonl"),
    '{"session_id":"s","ts":1,"text":"hi"}\n',
  );
  fs.copyFileSync(
    path.join(__dirname, "fixtures/ai-history/codex/.codex/sessions/2026/01/01/rollout-test-fixture.jsonl"),
    path.join(sessions, "rollout-copy.jsonl"),
  );

  const scan = scanAiArtifacts(root);
  assert.equal(scan.codex.length, 1);
  assert.equal(scan.codex[0].username, "bob");
  assert.ok(scan.codex[0].sessionCount >= 1);
});
