"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  getLocalAiHistoryCandidates,
  listClaudeCodeCandidatePaths,
  listChatgptCandidatePaths,
  listCopilotWorkspaceStorageCandidates,
  COPILOT_PRODUCT_NAMES,
  ARTIFACT_PATH_REFERENCES,
  isClaudeCodeArtifactRoot,
  defaultCursorHome,
} = require("../electron/parsers/ai-history/artifact-paths");
const { discoverLocalAiHistoryRoots } = require("../electron/parsers/ai-history/profile-scan");

test("getLocalAiHistoryCandidates includes all eight tools", () => {
  const tools = new Set(getLocalAiHistoryCandidates().map((c) => c.tool));
  assert.deepEqual(tools, new Set([
    "claude-code", "codex", "gemini-cli", "cursor", "chatgpt", "copilot",
    "windsurf", "continue",
  ]));
});

test("listClaudeCodeCandidatePaths includes CLI and Desktop roots", () => {
  const kinds = new Set(listClaudeCodeCandidatePaths().map((c) => c.kind));
  assert.ok(kinds.has("cli"));
  assert.ok(listClaudeCodeCandidatePaths().some((c) => c.path.endsWith(".claude")));
  const desktopPaths = listClaudeCodeCandidatePaths().filter((c) => c.kind === "desktop");
  for (const { path: p } of desktopPaths) {
    assert.match(p, /claude-code-sessions|local-agent-mode-sessions/);
  }
});

test("listChatgptCandidatePaths is non-empty on every platform", () => {
  assert.ok(listChatgptCandidatePaths().length >= 2);
});

test("Copilot products include VSCodium", () => {
  assert.ok(COPILOT_PRODUCT_NAMES.includes("VSCodium"));
  assert.ok(listCopilotWorkspaceStorageCandidates().some((p) => p.includes("VSCodium")));
});

test("ARTIFACT_PATH_REFERENCES documents each tool", () => {
  for (const tool of ["claude-code", "codex", "chatgpt", "gemini-cli", "cursor", "copilot"]) {
    assert.ok(ARTIFACT_PATH_REFERENCES[tool]?.paths?.length >= 1);
  }
});

test("isClaudeCodeArtifactRoot accepts CLI fixture", () => {
  const fixture = path.join(__dirname, "fixtures/ai-history/claude/.claude");
  assert.equal(isClaudeCodeArtifactRoot(fixture), true);
});

test("defaultCursorHome ends with .cursor", () => {
  assert.ok(defaultCursorHome().endsWith(".cursor") || defaultCursorHome().includes("cursor"));
});

test("discoverLocalAiHistoryRoots returns structured roots", async () => {
  const { roots, candidateCount } = await discoverLocalAiHistoryRoots();
  assert.ok(candidateCount >= 8);
  for (const r of roots) {
    assert.ok(r.tool && r.path && r.label);
  }
});
