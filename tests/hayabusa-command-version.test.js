const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildScanCommand,
  hayabusaMajorVersion,
} = require("../electron/analyzers/sigma/evtx-scanner/command-builder");

const OUT = { actualOutput: "/tmp/out.csv", tmpHtmlReport: "/tmp/report.html" };

function build(options, outputPaths = OUT) {
  return buildScanCommand({ dirPath: "/case", options, outputPaths }).args;
}

test("hayabusaMajorVersion parses the leading major from version strings", () => {
  assert.equal(hayabusaMajorVersion("v4.0.0"), 4);
  assert.equal(hayabusaMajorVersion("v3.2.0"), 3);
  assert.equal(hayabusaMajorVersion("2.19.0"), 2);
  assert.equal(hayabusaMajorVersion("Hayabusa v4.1.2"), 4);
  assert.equal(hayabusaMajorVersion(null), null);
  assert.equal(hayabusaMajorVersion(undefined), null);
  assert.equal(hayabusaMajorVersion(""), null);
});

test("v4+ uses the unified dfir-timeline subcommand with -t output type", () => {
  const csv = build({ version: "v4.0.0", outputMode: "csv" });
  assert.equal(csv[0], "dfir-timeline");
  assert.equal(csv[csv.indexOf("-t") + 1], "csv");
  assert.ok(!csv.includes("csv-timeline"));
  assert.ok(!csv.includes("--jsonl-output"));

  const jsonl = build({ version: "v4.0.0", outputMode: "jsonl" }, { actualOutput: "/tmp/out.jsonl", tmpHtmlReport: "/tmp/report.html" });
  assert.equal(jsonl[0], "dfir-timeline");
  assert.equal(jsonl[jsonl.indexOf("-t") + 1], "jsonl");
  assert.ok(!jsonl.includes("--jsonl-output"));
});

test("v2/v3 use the legacy csv-timeline/json-timeline subcommands without -t", () => {
  const csv = build({ version: "v3.2.0", outputMode: "csv" });
  assert.equal(csv[0], "csv-timeline");
  assert.ok(!csv.includes("-t"));
  assert.ok(!csv.includes("dfir-timeline"));

  const jsonl = build({ version: "v3.2.0", outputMode: "jsonl" }, { actualOutput: "/tmp/out.jsonl", tmpHtmlReport: "/tmp/report.html" });
  assert.equal(jsonl[0], "json-timeline");
  assert.ok(jsonl.includes("--jsonl-output"));
  assert.ok(!jsonl.includes("-t"));

  // Pre-v4 json (array) mode uses json-timeline with no --jsonl-output flag.
  const json = build({ version: "v2.19.0", outputMode: "json" }, { actualOutput: "/tmp/out.json", tmpHtmlReport: "/tmp/report.html" });
  assert.equal(json[0], "json-timeline");
  assert.ok(!json.includes("--jsonl-output"));
});

test("unknown version defaults to the modern (v4+) CLI shape", () => {
  for (const version of [null, undefined, "garbage"]) {
    const args = build({ version, outputMode: "csv" });
    assert.equal(args[0], "dfir-timeline", `version=${String(version)}`);
    assert.equal(args[args.indexOf("-t") + 1], "csv");
  }
});
