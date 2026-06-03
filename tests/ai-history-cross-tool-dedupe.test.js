"use strict";

// dedupeCrossToolPrompts collapses the SAME prompt across DIFFERENT tools, but must not silently
// drop distinct prompts that merely share a 120-char opening (the old key ignored tool + full body
// and dropped same-tool collisions with no AlsoInTools marker — forensic data loss).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { dedupeCrossToolPrompts } = require("../electron/parsers/ai-history/row-utils");

const PREFIX = "please review the following module and fix any bug you can find in the handler".padEnd(125, ".");

const row = (tool, tail, ts) => ({
  Role: "user", Tool: tool, Summary: PREFIX + tail, FullText: PREFIX + tail,
  Timestamp: ts || "2024-01-01 00:00:00", SessionId: "s1", AlsoInTools: "",
});

test("same tool + shared 120-char prefix but different bodies are kept (no silent drop)", () => {
  const out = dedupeCrossToolPrompts([row("Claude Code", " alpha", "2024-01-01 00:00:00"),
    row("Claude Code", " beta", "2024-06-01 00:00:00")]);
  assert.equal(out.length, 2, "distinct same-tool prompts survive");
});

test("same prompt across different tools merges with AlsoInTools provenance", () => {
  const out = dedupeCrossToolPrompts([row("Claude Code", " identical body"), row("Cursor", " identical body")]);
  assert.equal(out.length, 1, "the cross-tool duplicate collapses");
  assert.equal(out[0].AlsoInTools, "Claude Code, Cursor");
});

test("different tools sharing only a prefix (different bodies) are NOT falsely merged", () => {
  const out = dedupeCrossToolPrompts([row("Claude Code", " alpha"), row("Cursor", " beta")]);
  assert.equal(out.length, 2, "different prompts across tools are kept");
  assert.equal(out[0].AlsoInTools, "", "no false provenance");
});

test("rows without a cross-tool key (short/non-user) pass through untouched", () => {
  const short = { Role: "user", Tool: "Cursor", Summary: "hi", FullText: "hi", Timestamp: "2024-01-01 00:00:00" };
  const out = dedupeCrossToolPrompts([short, short]);
  assert.equal(out.length, 2);
});
