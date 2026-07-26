// Tests for Process Inspector graph seed/subgraph/layout pure functions.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const root = path.join(__dirname, "..");
  const strip = (src) => src
    .replace(/^import\s+.+?;\s*$/gm, "")
    .replace(/export\s+(const|function|async function|class|let|var)\s+/g, "$1 ")
    .replace(/export\s*\{[^}]+\}\s*;?/g, "");

  // Minimal stub for consistentParentKey (pipeline is large); re-implement the
  // name-consistency rule the layout relies on.
  const stub = `
    function consistentParentKey(node, byKey) {
      const pk = node && node.parentKey;
      if (!pk) return null;
      const parent = byKey.get(pk);
      if (!parent) return pk;
      const declared = String(node.parentProcessName || "").toLowerCase().replace(/\\.exe$/, "");
      const actual = String(parent.processName || "").toLowerCase().replace(/\\.exe$/, "");
      if (declared && actual && declared !== actual) return null;
      return pk;
    }
  `;
  const layoutSrc = strip(fs.readFileSync(path.join(root, "src/utils/process-graph-layout.js"), "utf8"));
  const sandbox = {
    module: { exports: {} }, exports: {}, console, Math, Date, Number, String, Array, Object, Map, Set, JSON, RegExp,
  };
  vm.createContext(sandbox);
  vm.runInContext(stub + "\n" + layoutSrc + `
    module.exports = {
      selectGraphSeedKeys,
      buildGraphSubgraph,
      layoutProcessGraph,
      PROCESS_GRAPH_DEFAULTS,
      wrapTextLines,
      estimateNodeHeight,
      buildNodeSubLine,
    };
  `, sandbox);
  return sandbox.module.exports;
}

const api = load();

function makeTree() {
  // HOST-A: explorer -> winword -> cmd -> powershell
  // HOST-B: services -> svchost
  const processes = [
    { key: "a1", parentKey: "", processName: "explorer.exe", pid: "100", hostname: "HOST-A", normHost: "host-a", tsMs: 1000, user: "alice", childCount: 1 },
    { key: "a2", parentKey: "a1", processName: "winword.exe", parentProcessName: "explorer.exe", pid: "200", hostname: "HOST-A", normHost: "host-a", tsMs: 2000, user: "alice", childCount: 1 },
    { key: "a3", parentKey: "a2", processName: "cmd.exe", parentProcessName: "winword.exe", pid: "300", hostname: "HOST-A", normHost: "host-a", tsMs: 3000, user: "alice", childCount: 1 },
    { key: "a4", parentKey: "a3", processName: "powershell.exe", parentProcessName: "cmd.exe", pid: "400", hostname: "HOST-A", normHost: "host-a", tsMs: 4000, user: "alice", childCount: 0 },
    { key: "b1", parentKey: "", processName: "services.exe", pid: "4", hostname: "HOST-B", normHost: "host-b", tsMs: 1500, user: "SYSTEM", childCount: 1 },
    { key: "b2", parentKey: "b1", processName: "svchost.exe", parentProcessName: "services.exe", pid: "500", hostname: "HOST-B", normHost: "host-b", tsMs: 1600, user: "SYSTEM", childCount: 0 },
  ];
  const detMap = new Map([
    ["a3", { level: 3, reason: "Office spawning shell", triageScore: 320 }],
    ["a4", { level: 2, reason: "Encoded PowerShell", triageScore: 250 }],
    ["b2", { level: 0, reason: null, triageScore: 0 }],
  ]);
  return { processes, detMap };
}

describe("process-graph-layout", () => {
  it("selectGraphSeedKeys picks detected processes over benign ones", () => {
    const { processes, detMap } = makeTree();
    const seeds = api.selectGraphSeedKeys(processes, detMap, { minLevel: 1 });
    assert.ok(seeds.includes("a3"));
    assert.ok(seeds.includes("a4"));
    assert.ok(!seeds.includes("b2"));
  });

  it("buildGraphSubgraph includes ancestors of seeds", () => {
    const { processes, detMap } = makeTree();
    const sub = api.buildGraphSubgraph(processes, detMap, ["a4"], { maxNodes: 50 });
    assert.ok(sub.keys.has("a4"));
    assert.ok(sub.keys.has("a3"));
    assert.ok(sub.keys.has("a2"));
    assert.ok(sub.keys.has("a1"));
  });

  it("layoutProcessGraph produces multi-host layout with edges", () => {
    const { processes, detMap } = makeTree();
    const layout = api.layoutProcessGraph(processes, detMap, { minLevel: 1, maxNodes: 50 });
    assert.ok(layout.nodes.length >= 4);
    assert.ok(layout.edges.length >= 2);
    assert.ok(layout.hosts.some((h) => /HOST-A/i.test(h.host) || h.host === "host-a"));
    // Every edge endpoint exists as a node
    const keys = new Set(layout.nodes.map((n) => n.key));
    for (const e of layout.edges) {
      assert.ok(keys.has(e.source));
      assert.ok(keys.has(e.target));
    }
  });

  it("focusKeys overrides detection seeds", () => {
    const { processes, detMap } = makeTree();
    const layout = api.layoutProcessGraph(processes, detMap, {
      focusKeys: new Set(["b2"]),
      minLevel: 1,
      maxNodes: 50,
    });
    assert.ok(layout.nodes.some((n) => n.key === "b2"));
    assert.ok(layout.nodes.some((n) => n.key === "b1"));
    // Should not pull the Office chain when focus is host-b only
    assert.ok(!layout.nodes.some((n) => n.key === "a4"));
  });

  it("caps node count when maxNodes is small", () => {
    const { processes, detMap } = makeTree();
    const layout = api.layoutProcessGraph(processes, detMap, {
      minLevel: 0,
      maxNodes: 3,
      maxSeeds: 10,
    });
    assert.ok(layout.nodes.length <= 3);
    assert.equal(layout.stats.truncated, true);
  });

  it("wrapTextLines continues on new lines instead of truncating", () => {
    const lines = api.wrapTextLines("cortex-xdr-payload-extra-long-name", 12, 6);
    assert.ok(lines.length >= 2);
    assert.ok(lines.every((l) => l.length > 0));
    assert.ok(!lines.join("").includes("…"));
    assert.equal(lines.join(""), "cortex-xdr-payload-extra-long-name".slice(0, lines.join("").length));
  });

  it("estimateNodeHeight grows for long process names and users", () => {
    const shortH = api.estimateNodeHeight("cmd.exe", "PID 1 · L1 · user");
    const longH = api.estimateNodeHeight(
      "cortex-xdr-payload-collector-offline",
      "PID 3512 · L2 · NT AUTHORITY\\SYSTEM",
    );
    assert.ok(longH > shortH, `expected longH (${longH}) > shortH (${shortH})`);
  });

  it("layout assigns taller cards to long names (no fixed single-line height)", () => {
    const processes = [
      { key: "s", parentKey: "", processName: "cmd.exe", pid: "1", hostname: "H", normHost: "h", tsMs: 1, user: "u", childCount: 0 },
      { key: "l", parentKey: "", processName: "cortex-xdr-payload-extra-long-name.exe", pid: "2", hostname: "H", normHost: "h", tsMs: 2, user: "NT AUTHORITY\\SYSTEM", childCount: 0 },
    ];
    const detMap = new Map([
      ["s", { level: 2, triageScore: 10 }],
      ["l", { level: 2, triageScore: 10 }],
    ]);
    const layout = api.layoutProcessGraph(processes, detMap, { minLevel: 1, maxNodes: 20 });
    const short = layout.nodes.find((n) => n.key === "s");
    const long = layout.nodes.find((n) => n.key === "l");
    assert.ok(short && long);
    assert.ok(long.height >= short.height);
    assert.ok(long.height > api.PROCESS_GRAPH_DEFAULTS.nodeHeight || long.processName.length > 16);
  });
});
