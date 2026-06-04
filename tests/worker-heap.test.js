"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { JobManager } = require("../electron/jobs/job-manager");
const { workerResourceLimits, workerHeapMb, DEFAULT_WORKER_HEAP_MB } = require("../electron/utils/worker-heap");

test("workerResourceLimits sets a generous old-space cap for worker threads", () => {
  const prev = process.env.TLE_WORKER_HEAP_MB;
  delete process.env.TLE_WORKER_HEAP_MB;
  try {
    assert.deepEqual(workerResourceLimits(), { maxOldGenerationSizeMb: DEFAULT_WORKER_HEAP_MB });
    assert.equal(workerHeapMb(), DEFAULT_WORKER_HEAP_MB);
  } finally {
    if (prev != null) process.env.TLE_WORKER_HEAP_MB = prev;
    else delete process.env.TLE_WORKER_HEAP_MB;
  }
});

test("TLE_WORKER_HEAP_MB overrides default worker heap", () => {
  const prev = process.env.TLE_WORKER_HEAP_MB;
  process.env.TLE_WORKER_HEAP_MB = "12288";
  try {
    assert.deepEqual(workerResourceLimits(), { maxOldGenerationSizeMb: 12288 });
  } finally {
    if (prev != null) process.env.TLE_WORKER_HEAP_MB = prev;
    else delete process.env.TLE_WORKER_HEAP_MB;
  }
});

test("JobManager starts workers with resourceLimits instead of invalid execArgv heap flags", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "irflow-worker-heap-"));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });
  const workerPath = path.join(tmp, "ok-worker.js");
  fs.writeFileSync(
    workerPath,
    [
      '"use strict";',
      'const { parentPort } = require("worker_threads");',
      'parentPort.postMessage({ type: "result", result: { ok: true } });',
      "",
    ].join("\n"),
  );

  const manager = new JobManager({ safeSend: () => {}, dbg: () => {} });
  const { promise } = manager.startWorkerJob({ type: "heap-smoke", worker: workerPath });
  assert.deepEqual(await promise, { ok: true });
});
