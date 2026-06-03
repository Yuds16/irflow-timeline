/**
 * ai-history-profile-worker.js — merged AI profile extract off the main thread.
 * Streams each source into SQLite without holding the full merged row set in memory.
 */

const { parentPort, workerData } = require("worker_threads");
const TimelineDB = require("../db");
const { AI_HISTORY_COLUMNS } = require("../parsers/ai-history/schema");
const { extractMergedAiHistoryRootsToDb } = require("../parsers/ai-history/profile-scan");

let cancelled = false;

parentPort.on("message", (message = {}) => {
  if (message?.type === "cancel") cancelled = true;
});

function checkAbort() {
  if (cancelled) throw Object.assign(new Error("AI history extraction canceled"), { canceled: true });
}

function progress(patch) {
  parentPort.postMessage({
    type: "progress",
    progress: { jobId: workerData.jobId, ...patch },
  });
}

function cleanupDb(db, tabId) {
  if (!db) return;
  try { db.releaseTab(tabId); } catch { /* ignore */ }
  try { db.closeAll(); } catch { /* ignore */ }
}

(async () => {
  const {
    roots,
    includeSubagents,
    user,
    host,
    dbPath,
    tabId,
  } = workerData;

  const db = new TimelineDB();
  try {
    checkAbort();
    db._dbPathHint = dbPath;

    const {
      rowCount,
      importNotice,
      failures,
    } = await extractMergedAiHistoryRootsToDb(
      db,
      tabId,
      roots || [],
      { user: user || "", host: host || "" },
      {
        includeSubagents: !!includeSubagents,
        headers: AI_HISTORY_COLUMNS,
        onProgress: (p) => progress(p),
        checkAbort,
      },
    );

    if (!rowCount) {
      cleanupDb(db, tabId);
      parentPort.postMessage({
        type: "result",
        result: {
          error: failures?.length
            ? failures.map((f) => `${f.label}: ${f.error}`).join("; ")
            : "Sources were found but contained no message rows.",
          failures: failures || [],
        },
      });
      return;
    }

    progress({
      phase: "loading",
      percent: 98,
      statusDetail: `Finalizing ${rowCount.toLocaleString()} rows…`,
      rowsSoFar: rowCount,
    });

    const finalized = db.finalizeImport(tabId, { skipWalPromotion: true });
    progress({
      phase: "loading",
      percent: 99,
      statusDetail: `Handing off ${rowCount.toLocaleString()} rows…`,
      rowsSoFar: rowCount,
    });
    const descriptor = db.getTabWorkerDescriptor(tabId);
    cleanupDb(db, tabId);

    parentPort.postMessage({
      type: "result",
      result: {
        ...finalized,
        dbPath: descriptor.dbPath,
        isLargeFile: descriptor.isLargeFile,
        ftsReady: descriptor.ftsReady,
        indexesReady: descriptor.indexesReady,
        indexedCols: descriptor.indexedCols,
        importNotice: importNotice || null,
        failures: failures || [],
        rowObjects: null,
      },
    });
  } catch (err) {
    cleanupDb(db, tabId);
    if (err?.canceled) {
      progress({ phase: "cancelled", done: true });
      process.exit(1);
      return;
    }
    parentPort.postMessage({
      type: "result",
      result: { error: err?.message || "AI history profile extract failed", stack: err?.stack },
    });
  }
})();
