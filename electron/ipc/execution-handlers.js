/**
 * ipc/execution-handlers.js — program-execution artifact handlers.
 *
 *   decode-shimcache / decode-userassist — decode a single artifact out of an imported raw
 *     registry hive (SYSTEM / NTUSER) into rows the renderer opens as a new tab.
 *   analyze-program-execution — correlate execution evidence across every loaded Amcache /
 *     SYSTEM / NTUSER hive into one unified "what ran" table.
 *
 * All three read the hive bytes from the tab's original file (tracked in _tabMeta.filePath) and
 * return row objects (key->value); the renderer opens them via the shared rows->tab mechanism.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { dialog } = require("electron");

const { dbg } = require("../logger");
const { openDialogOptions } = require("../utils/open-dialog");
const { defaultDecodeAiHistoryDialogPath } = require("../parsers/ai-history/open-dialog-paths");
const { parseAmcacheBuffer } = require("../parsers/amcache");
const { parseShimCacheFromHive } = require("../parsers/shimcache");
const { parseUserAssistBuffer } = require("../parsers/userassist");
const { getToolConfig, resolveToolBinary, runToolToCsv, envKeyFor } = require("../parsers/external-parsers");
const { scanTriageDir, KIND_LABELS } = require("../parsers/triage");
const { scanAiArtifacts, KIND_LABELS: AI_KIND_LABELS } = require("../parsers/ai-artifacts");
const {
  extractAiHistory,
  extractClaudeDir,
  extractCodexDir,
  extractChatgptDir,
  extractGeminiCliDir,
  extractCursorDir,
  extractCopilotPath,
  resolveClaudeDir,
  resolveCodexHome,
  resolveChatgptDir,
  resolveGeminiCliRoot,
  resolveCursorRoot,
  resolveCopilotRoot,
  resolveWindsurfUserDir,
  continueHome,
  defaultCodexHome,
  defaultCopilotWorkspaceStorage,
  AI_HISTORY_TOOLS,
  getCopilotExtractionStats,
} = require("../parsers/ai-history");
const {
  buildAiHistoryImportNotice,
  buildCopilotExtractionStats,
} = require("../parsers/ai-history/import-meta");
const {
  discoverAiHistoryRoots,
  buildEmptyAiScanReport,
  extractMergedAiHistoryRoots,
} = require("../parsers/ai-history/profile-scan");
const {
  triageSelectedHasScopeChoice,
  buildTriageAiRoots,
  groupTriageRootsByTool,
  triageAiTabFileName,
} = require("../parsers/ai-history/triage-extract");
const { confineRootsToScope } = require("../parsers/ai-history/resolve-root");
const {
  createAiHistoryExtractAbortToken,
  requestAiHistoryExtractAbort,
  AiHistoryExtractAbortedError,
} = require("../parsers/ai-history/extract-abort");
const {
  authorizeAiScanTarget,
  authorizeAiArtifactPick,
  authorizeDiscoveredRoots,
  assertAiReadablePath,
  assertAiScanTarget,
  assertExtractRootsAuthorized,
} = require("../parsers/ai-history/path-auth");
const { deriveUser, deriveHost, annotateCsvUserHost } = require("../parsers/path-attribution");
const { parseCSVLine } = require("../parsers/csv");
const {
  correlateExecution, fromAmcacheRows, fromShimcacheRows, fromUserassistRows, fromPrefetchCsv,
} = require("../analyzers/program-execution");

/** Triage AI kinds → extractor (order matches manifest labels). */
const AI_TRIAGE_SOURCES = [
  { kind: "aiClaude", tool: "claude-code", extract: extractClaudeDir },
  { kind: "aiCodex", tool: "codex", extract: extractCodexDir },
  { kind: "aiChatgpt", tool: "chatgpt", extract: extractChatgptDir },
  { kind: "aiGemini", tool: "gemini-cli", extract: extractGeminiCliDir },
  { kind: "aiCursor", tool: "cursor", extract: extractCursorDir },
  { kind: "aiCopilot", tool: "copilot", extract: extractCopilotPath },
  { kind: "aiWindsurf", tool: "windsurf", extract: null },
  { kind: "aiContinue", tool: "continue", extract: null },
];

function buildTriageAiImportNotice(rows) {
  const importMeta = {};
  if (rows._claudeDesktopStats) importMeta.claudeDesktop = rows._claudeDesktopStats;
  if (rows._chatgptStats) importMeta.chatgpt = rows._chatgptStats;
  importMeta.copilot = buildCopilotExtractionStats(rows, getCopilotExtractionStats(rows));
  if (rows._cursorSyntheticTimestamps || rows._cursorComposerStats) {
    importMeta.cursor = {
      syntheticTimestamps: !!rows._cursorSyntheticTimestamps,
      composer: rows._cursorComposerStats,
    };
  }
  if (rows._windsurfStats) importMeta.windsurf = rows._windsurfStats;
  if (rows._codexStateSqliteStats) importMeta.codexStateSqlite = rows._codexStateSqliteStats;
  if (rows._windsurfCascadeStats) importMeta.windsurfCascade = rows._windsurfCascadeStats;
  if (rows._parseErrors) importMeta.parseErrors = rows._parseErrors;
  if (rows._capped) importMeta.capped = rows._capped;
  return buildAiHistoryImportNotice(importMeta) || null;
}

/**
 * @param {object} scan — merged triage + ai artifact scan
 * @param {string} dir — collection root
 * @param {Set<string>} selected — selected manifest kinds
 * @param {{ mergeAiHistory?: boolean }} [options]
 * @returns {Promise<Array<{ rows: object[], name: string, sourceFormat: string, importNotice: string|null }>>}
 */
async function buildTriageAiHistories(scan, dir, selected, options = {}) {
  const mergeAiHistory = options.mergeAiHistory !== false;
  const roots = buildTriageAiRoots(scan, dir, selected, AI_TRIAGE_SOURCES);
  if (!roots.length) return [];

  assertAiScanTarget(dir);
  assertExtractRootsAuthorized(roots, dir);

  const collLabel = path.basename(dir) || dir;
  const defaultHost = path.basename(dir) || "";
  const extractOpts = {
    includeSubagents: !!options.includeSubagents,
    skipSubagents: !options.includeSubagents,
    skipFinalize: true,
    checkAbort: options.checkAbort,
  };
  const aiHistories = [];

  if (mergeAiHistory) {
    const { rows, importNotice, failures } = await extractMergedAiHistoryRoots(
      roots,
      { user: "", host: defaultHost },
      extractOpts,
    );
    if (rows.length) {
      aiHistories.push({
        rows,
        name: `AI Query History — ${collLabel} (${rows.length.toLocaleString()})`,
        sourceFormat: "ai-history-merged",
        importNotice: importNotice || buildTriageAiImportNotice(rows),
        failures: failures || [],
      });
    }
    return aiHistories;
  }

  for (const { tool, roots: toolRoots } of groupTriageRootsByTool(roots)) {
    const meta = AI_HISTORY_TOOLS[tool];
    if (!meta || !toolRoots.length) continue;
    const endpointUser = toolRoots[0]?.endpointUser || "";
    const { rows, importNotice, failures } = await extractMergedAiHistoryRoots(
      toolRoots,
      { user: endpointUser, host: toolRoots[0]?.endpointHost || defaultHost },
      extractOpts,
    );
    if (!rows.length) continue;
    const labelUser = endpointUser ? ` — ${endpointUser}` : "";
    aiHistories.push({
      rows,
      name: `${meta.tabPrefix} (${rows.length.toLocaleString()})${labelUser}`,
      sourceFormat: `ai-history-${tool}`,
      importNotice: importNotice || buildTriageAiImportNotice(rows),
      failures: failures || [],
    });
  }

  return aiHistories;
}

const AI_HISTORY_IPC_QUERY_OPTS = {
  omitHeaders: ["FullText"],
  truncateColumns: { Summary: 240, Description: 480, Transcript: 480 },
};

const AI_HISTORY_EMPTY_COL_OMIT = ["FullText", "Description", "Transcript"];

function finishAiHistoryWorkerImport(ctx, tabId, result, { fileName, sourceFormat, importNotice, sendProgress }) {
  const { db, _tabMeta, scheduleIndexBuild, safeSend } = ctx;
  const isAiHistory = typeof sourceFormat === "string" && sourceFormat.startsWith("ai-history");
  if (typeof sendProgress === "function") {
    sendProgress({
      phase: "loading",
      percent: 99,
      statusDetail: "Opening timeline database…",
      rowsSoFar: result.rowCount || 0,
    });
  }
  db.adoptTabFromFile(tabId, {
    dbPath: result.dbPath,
    headers: result.headers,
    rowCount: result.rowCount,
    tsColumns: result.tsColumns,
    numericColumns: result.numericColumns || [],
    isLargeFile: result.isLargeFile || false,
  });
  if (_tabMeta) _tabMeta.set(tabId, { filePath: "", sourceFormat });

  const rowCount = result.rowCount || 0;
  if (typeof sendProgress === "function") {
    sendProgress({
      phase: "loading",
      percent: 99,
      statusDetail: "Preparing grid…",
      rowsSoFar: rowCount,
    });
  }
  const aiHistoryLarge = isAiHistory && rowCount >= 50_000;
  const initialLimit = isAiHistory
    ? (rowCount >= 20_000 ? 0 : rowCount >= 10_000 ? 100 : rowCount >= 5_000 ? 200 : 400)
    : (result.isLargeFile ? 2500 : 5000);
  const initialData = initialLimit > 0
    ? db.queryRows(tabId, {
      offset: 0,
      limit: initialLimit,
      sortCol: null,
      sortDir: "asc",
      ...(isAiHistory ? AI_HISTORY_IPC_QUERY_OPTS : {}),
    })
    : { rows: [], totalFiltered: rowCount };
  const emptyColumns = isAiHistory
    ? db.getEmptyColumns(tabId, { omitHeaders: AI_HISTORY_EMPTY_COL_OMIT, forceSample: true })
    : db.getEmptyColumns(tabId);

  safeSend("import-progress", {
    tabId,
    fileName,
    rowsImported: rowCount,
    percent: 100,
    phase: "finalizing",
    statusDetail: "Timeline ready",
  });

  safeSend("import-complete", {
    tabId,
    fileName,
    headers: result.headers,
    rowCount: result.rowCount,
    tsColumns: result.tsColumns,
    numericColumns: result.numericColumns || [],
    initialRows: initialData.rows,
    totalFiltered: initialData.totalFiltered,
    emptyColumns,
    sourceFormat,
    importNotice: importNotice || null,
    isLargeFile: result.isLargeFile || aiHistoryLarge,
    initialRowsDeferred: isAiHistory && initialLimit === 0,
  });
  if (scheduleIndexBuild) scheduleIndexBuild(tabId);

  return {
    tabId,
    openedTab: true,
    name: fileName,
    count: result.rowCount,
    sourceFormat,
    importNotice: importNotice || null,
  };
}

async function runTriageAiExtractWorker(ctx, workerOpts = {}) {
  const { jobManager, nextTabId, _newTempDbPath, safeSend } = ctx;
  const {
    roots,
    includeSubagents,
    merge,
    tool,
    collectionDir,
    sendProgress,
  } = workerOpts;
  try {
    assertAiScanTarget(collectionDir);
    assertExtractRootsAuthorized(roots, collectionDir);
  } catch (e) {
    return { error: e.message || "AI triage paths are not authorized." };
  }
  const user = os.userInfo().username || "";
  const host = os.hostname() || "";
  const tabId = nextTabId();
  const dbPath = _newTempDbPath(tabId);
  const sourceFormat = merge ? "ai-history-merged" : `ai-history-${tool}`;
  const collLabel = path.basename(collectionDir) || collectionDir;
  const importBaseName = merge
    ? `AI Query History — ${collLabel}`
    : (AI_HISTORY_TOOLS[tool]?.tabPrefix || "AI History") + ` — ${collLabel}`;

  safeSend("import-start", { tabId, fileName: importBaseName, filePath: "", fileSize: 0 });

  const { promise } = jobManager.startWorkerJob({
    type: "ai-history-triage",
    worker: "ai-history-profile-worker.js",
    workerData: {
      roots,
      includeSubagents: !!includeSubagents,
      user,
      host,
      dbPath,
      tabId,
      sourceFormat,
    },
    channels: { progress: "ai-history-profile-progress" },
    metadata: { tabId, sourceCount: roots.length, triage: true },
  });

  let result;
  try {
    result = await promise;
  } catch (e) {
    safeSend("import-error", { tabId, fileName: importBaseName, error: e?.message || "AI history extraction failed" });
    if (e?.cancelled || e?.canceled) return { canceled: true };
    return { error: e?.message || "AI history extraction failed" };
  }
  if (result?.error) {
    safeSend("import-error", { tabId, fileName: importBaseName, error: result.error });
    return { error: result.error, failures: result.failures || [] };
  }

  const fileName = triageAiTabFileName(collectionDir, merge, tool, result.rowCount);
  const opened = finishAiHistoryWorkerImport(ctx, tabId, result, {
    fileName,
    sourceFormat,
    importNotice: result.importNotice || null,
  });

  if (typeof sendProgress === "function") {
    sendProgress({
      phase: "complete",
      percent: 100,
      statusDetail: `Extracted ${result.rowCount.toLocaleString()} messages`,
      rowsSoFar: result.rowCount,
    });
  }

  return { ...opened, failures: result.failures || [], partial: (result.failures || []).length > 0 };
}

/**
 * Worker-backed triage AI extract when jobManager/db are available; otherwise main-thread fallback.
 */
async function runTriageAiExtraction(ctx, scan, dir, selected, options = {}) {
  const roots = buildTriageAiRoots(scan, dir, selected, AI_TRIAGE_SOURCES);
  if (!roots.length) {
    return { aiHistories: [], aiHistory: null, aiTabsOpened: [] };
  }

  const { jobManager, db, nextTabId, _newTempDbPath, safeSend } = ctx;
  const useWorker = !!(jobManager && db && nextTabId && _newTempDbPath);
  if (!useWorker) {
    const abortToken = createAiHistoryExtractAbortToken();
    try {
      const aiHistories = await buildTriageAiHistories(scan, dir, selected, {
        ...options,
        checkAbort: () => abortToken.checkAbort(),
      });
      return { aiHistories, aiHistory: aiHistories[0] || null, aiTabsOpened: [] };
    } catch (e) {
      if (e instanceof AiHistoryExtractAbortedError || e?.canceled) return { canceled: true };
      throw e;
    } finally {
      abortToken.dispose();
    }
  }

  const mergeAiHistory = options.mergeAiHistory !== false;
  const sendProgress = (patch) => safeSend("ai-history-profile-progress", patch);
  const aiTabsOpened = [];

  if (mergeAiHistory) {
    const opened = await runTriageAiExtractWorker(
      { ...ctx, jobManager, nextTabId, _newTempDbPath, safeSend },
      {
        roots,
        includeSubagents: options.includeSubagents,
        merge: true,
        collectionDir: dir,
        sendProgress,
      },
    );
    if (opened?.openedTab) aiTabsOpened.push(opened);
    if (opened?.error) {
      return { error: opened.error, aiHistories: [], aiHistory: null, aiTabsOpened, failures: opened.failures };
    }
    return { aiHistories: [], aiHistory: null, aiTabsOpened };
  }

  for (const { tool, roots: toolRoots } of groupTriageRootsByTool(roots)) {
    const opened = await runTriageAiExtractWorker(
      { ...ctx, jobManager, nextTabId, _newTempDbPath, safeSend },
      {
        roots: toolRoots,
        includeSubagents: options.includeSubagents,
        merge: false,
        tool,
        collectionDir: dir,
        sendProgress,
      },
    );
    if (opened?.openedTab) aiTabsOpened.push(opened);
    if (opened?.error) {
      dbg("EXEC", "triage AI worker tool failed", { tool, error: opened.error });
    }
  }

  return { aiHistories: [], aiHistory: null, aiTabsOpened };
}

/** [["a"],["b"]] + ["col"] -> [{col:"a"},{col:"b"}] for the rows->tab importer. */
function rowsToObjects(rows, headers) {
  return rows.map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i] ?? ""; });
    return o;
  });
}

function readHive(meta) {
  if (!meta || !meta.filePath) return { error: "This tab has no source file to decode." };
  if (!fs.existsSync(meta.filePath)) return { error: `Original hive file no longer exists: ${meta.filePath}` };
  try {
    return { buffer: fs.readFileSync(meta.filePath), sourceName: path.basename(meta.filePath) };
  } catch (e) {
    return { error: `Cannot read hive file: ${e.message}` };
  }
}

async function runAiHistoryProfileExtractWorker(ctx, roots, opts = {}) {
  const {
    db,
    jobManager,
    nextTabId,
    _newTempDbPath,
    scheduleIndexBuild,
    _tabMeta,
  } = ctx;
  const {
    sendProgress,
    useSubagents,
    user,
    host,
    resolvedScanRoot,
    resolvedScanMode,
  } = opts;
  const safeSend = opts.safeSend || ctx.safeSend;
  if (typeof safeSend !== "function") {
    throw new Error("AI history worker requires safeSend");
  }

  const tabId = nextTabId();
  const dbPath = _newTempDbPath(tabId);
  const collSuffix = resolvedScanRoot ? ` — ${path.basename(resolvedScanRoot)}` : "";
  const baseName = opts.baseName || `AI Query History${collSuffix}`;
  const sourceFormat = opts.sourceFormat || "ai-history-merged";
  const deferImportStart = !!opts.deferImportStart;

  if (!deferImportStart) {
    safeSend("import-start", { tabId, fileName: baseName, filePath: "", fileSize: 0 });
  }
  const { promise } = jobManager.startWorkerJob({
    type: "ai-history-profile",
    worker: "ai-history-profile-worker.js",
    workerData: {
      roots,
      includeSubagents: useSubagents,
      user,
      host,
      dbPath,
      tabId,
    },
    channels: { progress: "ai-history-profile-progress" },
    metadata: { tabId, sourceCount: roots.length },
  });

  let result;
  try {
    result = await promise;
  } catch (e) {
    if (e?.cancelled || e?.canceled) return { canceled: true };
    safeSend("import-error", { tabId, fileName: baseName, error: e?.message || "AI history profile extract failed" });
    return { error: e?.message || "AI history profile extract failed" };
  }
  if (result?.error) {
    safeSend("import-error", { tabId, fileName: baseName, error: result.error });
    return { error: result.error, failures: result.failures || [] };
  }

  if (deferImportStart) {
    safeSend("import-start", { tabId, fileName: baseName, filePath: "", fileSize: 0 });
  }

  // Tab bar already appends (totalRows); keep the tab title as the tool prefix only.
  const fileName = baseName;
  sendProgress({
    phase: "loading",
    percent: 99,
    statusDetail: "Opening timeline tab…",
    rowsSoFar: result.rowCount,
  });
  finishAiHistoryWorkerImport(
    { db, _tabMeta, scheduleIndexBuild, safeSend },
    tabId,
    result,
    {
      fileName,
      sourceFormat,
      importNotice: result.importNotice || null,
      sendProgress,
    },
  );

  sendProgress({
    phase: "complete",
    percent: 100,
    statusDetail: `Extracted ${result.rowCount.toLocaleString()} messages`,
    logLine: (result.failures || []).length
      ? `Done with ${result.failures.length} source error(s) — timeline tab ready`
      : "Done — timeline tab ready",
    rowsSoFar: result.rowCount,
  });

  const sourcesLabel = roots.map((r) => r.label).join(", ");
  return {
    tabId,
    openedTab: true,
    name: fileName,
    count: result.rowCount,
    sourceFormat,
    importNotice: result.importNotice || null,
    sources: roots.map((r) => ({ tool: r.tool, path: r.path, label: r.label })),
    failures: result.failures || [],
    partial: (result.failures || []).length > 0,
    sourcesLabel,
    scanRoot: resolvedScanRoot || null,
    scanMode: resolvedScanMode || "local",
  };
}

module.exports = function registerExecutionHandlers(safeHandle, safeSend, ctx) {
  const {
    _tabMeta,
    _activeWindow,
    db,
    jobManager,
    nextTabId,
    _newTempDbPath,
    scheduleIndexBuild,
  } = ctx;
  // Decode ShimCache (AppCompatCache) from an imported SYSTEM hive tab.
  safeHandle("decode-shimcache", (event, { tabId } = {}) => {
    const meta = _tabMeta.get(tabId);
    if (!meta || meta.sourceFormat !== "raw-registry") return { error: "Select an imported SYSTEM hive (raw registry) tab first." };
    const hive = readHive(meta);
    if (hive.error) return { error: hive.error };
    const { rows, headers, stats } = parseShimCacheFromHive(hive.buffer, { sourceName: hive.sourceName });
    if (!stats.found) return { error: "No AppCompatCache found in this hive — is it a SYSTEM hive?" };
    if (!stats.supported && rows.length === 0) return { error: stats.note || "Unsupported AppCompatCache format." };
    dbg("EXEC", "decode-shimcache", { count: rows.length, format: stats.format });
    return { rows: rowsToObjects(rows, headers), name: `ShimCache — ${hive.sourceName}`, count: rows.length };
  });

  // Decode UserAssist from an imported NTUSER hive tab.
  safeHandle("decode-userassist", (event, { tabId } = {}) => {
    const meta = _tabMeta.get(tabId);
    if (!meta || meta.sourceFormat !== "raw-registry") return { error: "Select an imported NTUSER.DAT (raw registry) tab first." };
    const hive = readHive(meta);
    if (hive.error) return { error: hive.error };
    const { rows, headers, stats } = parseUserAssistBuffer(hive.buffer, { sourceName: hive.sourceName });
    if (!stats.found) return { error: "No UserAssist key found in this hive — is it an NTUSER.DAT?" };
    dbg("EXEC", "decode-userassist", { count: rows.length });
    return { rows: rowsToObjects(rows, headers), name: `UserAssist — ${hive.sourceName}`, count: rows.length };
  });

  // Correlate execution evidence across every loaded Amcache / SYSTEM / NTUSER hive.
  safeHandle("analyze-program-execution", (event, { tabId } = {}) => {
    const sources = { amcache: [], shimcache: [], userassist: [], evtx: [] };
    const contributors = new Set();

    for (const [tid, meta] of _tabMeta) {
      if (!meta || !meta.filePath) continue;
      try {
        if (meta.sourceFormat === "amcache") {
          const buf = fs.readFileSync(meta.filePath);
          const { rows } = parseAmcacheBuffer(buf, { sourceName: path.basename(meta.filePath) });
          if (rows.length) { sources.amcache.push(...fromAmcacheRows(rows)); contributors.add("Amcache"); }
        } else if (meta.sourceFormat === "raw-registry") {
          const buf = fs.readFileSync(meta.filePath);
          const sourceName = path.basename(meta.filePath);
          const user = deriveUser(meta.filePath); // attributable when the hive was imported from a user-profile path
          const sc = parseShimCacheFromHive(buf, { sourceName });
          if (sc.stats.found && sc.rows.length) { sources.shimcache.push(...fromShimcacheRows(sc.rows)); contributors.add("ShimCache"); }
          const ua = parseUserAssistBuffer(buf, { sourceName });
          if (ua.stats.found && ua.rows.length) { sources.userassist.push(...fromUserassistRows(ua.rows).map((r) => ({ ...r, user }))); contributors.add("UserAssist"); }
        }
      } catch (e) {
        dbg("EXEC", "source read failed", { tid, err: e.message });
      }
    }

    if (!sources.amcache.length && !sources.shimcache.length && !sources.userassist.length) {
      return { error: "No execution artifacts loaded. Open an Amcache.hve, a SYSTEM hive, or an NTUSER.DAT first." };
    }

    const rows = correlateExecution(sources);
    dbg("EXEC", "analyze-program-execution", { contributors: [...contributors], rows: rows.length });
    return { rows, name: `Program Execution (${rows.length})`, contributors: [...contributors] };
  });

  // Decode a Windows artifact via a bundled IRFlow Collector parser (prefetch / lnk / jumplist /
  // shellbag). Runs the tool over a chosen file or folder and returns the path to its EZ-Tools
  // CSV; the renderer imports that through the normal pipeline so the KAPE column profile applies.
  // Extract Claude Code AI query history from a .claude directory or JSONL file.
  safeHandle("decode-ai-history", async (event, { path: inputPath, tool, includeSubagents, ...options } = {}) => {
    const selectedTool = tool || "claude-code";
    const meta = AI_HISTORY_TOOLS[selectedTool];
    if (!meta) {
      return { error: `Unsupported AI tool: ${selectedTool}. Supported: ${Object.keys(AI_HISTORY_TOOLS).join(", ")}.` };
    }

    let target = inputPath;
    if (!target) {
      const win = typeof _activeWindow === "function" ? _activeWindow() : null;
      const dialogByTool = {
        chatgpt: {
          title: "Select ChatGPT Desktop data",
          message: "Choose the ChatGPT app data folder (com.openai.chat, Atlas, or Roaming\\ChatGPT)",
          filters: [{ name: "SQLite / LevelDB", extensions: ["db", "sqlite", "sqlite3", "ldb"] }],
        },
        "gemini-cli": {
          title: "Select Gemini CLI artifacts",
          message: "Choose a .gemini folder or a session-*.json file under tmp/.../chats/",
          filters: [{ name: "Gemini CLI session", extensions: ["json"] }],
        },
        codex: {
          title: "Select OpenAI Codex artifacts",
          message: "Choose a .codex folder (CLI/Desktop sessions, history.jsonl, rollout-*.jsonl)",
          filters: [{ name: "Codex JSONL", extensions: ["jsonl"] }],
        },
        "claude-code": {
          title: "Select Claude Code artifacts",
          message: "Choose a .claude folder, history.jsonl, or a session .jsonl file",
          filters: [{ name: "Claude Code JSONL", extensions: ["jsonl"] }],
        },
        cursor: {
          title: "Select Cursor agent transcripts",
          message: "Choose a .cursor folder, projects tree, or an agent-transcripts .jsonl file",
          filters: [{ name: "Cursor transcript JSONL", extensions: ["jsonl"] }],
        },
        copilot: {
          title: "Select GitHub Copilot chat sessions",
          message: "Choose workspaceStorage, a chatSessions folder, or a session .json/.jsonl file",
          filters: [{ name: "Copilot chat session", extensions: ["json", "jsonl"] }],
        },
        windsurf: {
          title: "Select Windsurf chat data",
          message: "Choose Windsurf User folder (workspaceStorage / globalStorage state.vscdb)",
          filters: [{ name: "SQLite", extensions: ["vscdb", "db"] }],
        },
        continue: {
          title: "Select Continue sessions",
          message: "Choose a .continue folder or sessions/*.json",
          filters: [{ name: "Continue session", extensions: ["json"] }],
        },
      };
      const dlg = dialogByTool[selectedTool] || dialogByTool["claude-code"];
      const homedir = os.homedir();
      const hinted = defaultDecodeAiHistoryDialogPath(selectedTool);
      const defaultPath = hinted && fs.existsSync(hinted) ? hinted : hinted;
      const res = await dialog.showOpenDialog(win, openDialogOptions({
        title: dlg.title,
        message: dlg.message,
        properties: ["openFile", "openDirectory"],
        filters: dlg.filters,
        buttonLabel: "Extract",
        defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : homedir,
      }));
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true };
      target = res.filePaths[0];
      authorizeAiArtifactPick(target, { label: meta.label });
    }

    try {
      assertAiReadablePath(target);
    } catch (e) {
      return { error: e.message || "Path is not authorized for AI extraction." };
    }

    const root = selectedTool === "chatgpt"
      ? (resolveChatgptDir(target) || target)
      : selectedTool === "gemini-cli"
        ? (resolveGeminiCliRoot(target) || target)
        : selectedTool === "codex"
          ? (resolveCodexHome(target) || target)
          : selectedTool === "cursor"
            ? (resolveCursorRoot(target) || target)
            : selectedTool === "copilot"
              ? (resolveCopilotRoot(target) || target)
              : selectedTool === "windsurf"
                ? (resolveWindsurfUserDir(target) || target)
                : selectedTool === "continue"
                  ? (continueHome(target) || target)
                  : (resolveClaudeDir(target) || target);
    const extractTarget = root || target;
    const user = deriveUser(extractTarget);
    const host = "";

    const scopeTools = new Set(["claude-code", "codex", "cursor"]);
    if (options?.promptScope && scopeTools.has(selectedTool) && options?.includeSubagents == null) {
      try {
        const st = fs.statSync(target);
        if (st.isDirectory()) {
          authorizeAiArtifactPick(target, { label: meta.label });
          return {
            needsScopeChoice: true,
            tool: selectedTool,
            target,
            extractTarget,
            label: meta.label,
          };
        }
      } catch { /* ignore */ }
    }

    const useSubagents = options?.includeSubagents != null ? !!options.includeSubagents : false;
    const roots = [{
      tool: selectedTool,
      path: extractTarget,
      label: meta.label,
      endpointUser: user,
      endpointHost: host,
    }];

    if (options?.prepareOnly) {
      return {
        prepared: true,
        tool: selectedTool,
        target,
        extractTarget,
        label: meta.label,
      };
    }

    const workerCtx = jobManager && db && nextTabId && _newTempDbPath
      ? { db, jobManager, nextTabId, _newTempDbPath, scheduleIndexBuild, _tabMeta, safeSend }
      : null;
    const sendProgress = (patch) => safeSend("ai-history-profile-progress", patch);

    try {
      if (workerCtx) {
        const workerResult = await runAiHistoryProfileExtractWorker(
          workerCtx,
          roots,
          {
            safeSend,
            sendProgress,
            useSubagents,
            user,
            host,
            baseName: meta.tabPrefix,
            sourceFormat: `ai-history-${selectedTool}`,
            deferImportStart: true,
          },
        );
        if (workerResult?.canceled) return { canceled: true };
        if (workerResult?.error) {
          const msg = workerResult.error;
          if (/no message|no rows|contained no/i.test(msg)) {
            return { error: `No ${meta.label} messages found at this path.` };
          }
          return { error: msg };
        }
        dbg("EXEC", "decode-ai-history", {
          tool: selectedTool,
          target: extractTarget,
          count: workerResult.count,
          tabId: workerResult.tabId,
        });
        return { ...workerResult, tool: selectedTool };
      }

      const rows = await extractAiHistory(selectedTool, extractTarget, { user, host }, {
        includeSubagents: useSubagents,
      });
      if (!rows.length) {
        return { error: `No ${meta.label} messages found at this path.` };
      }
      const labelUser = user ? ` — ${user}` : "";
      dbg("EXEC", "decode-ai-history (inline)", { tool: selectedTool, target, count: rows.length });
      return {
        rows,
        name: `${meta.tabPrefix} (${rows.length.toLocaleString()})${labelUser}`,
        count: rows.length,
        tool: selectedTool,
        sourceFormat: `ai-history-${selectedTool}`,
        importNotice: buildAiHistoryImportNotice({
          copilot: buildCopilotExtractionStats(rows, getCopilotExtractionStats(rows)),
          claudeDesktop: rows._claudeDesktopStats,
          chatgpt: rows._chatgptStats,
          cursor: { syntheticTimestamps: !!rows._cursorSyntheticTimestamps, composer: rows._cursorComposerStats },
          windsurf: rows._windsurfStats,
          codexStateSqlite: rows._codexStateSqliteStats,
          windsurfCascade: rows._windsurfCascadeStats,
          parseErrors: rows._parseErrors,
        }) || null,
      };
    } catch (e) {
      return { error: `AI history extraction failed: ${e.message}` };
    }
  });

  async function runAiHistoryProfileDiscover(sendProgress, { scanRoot, scanMode } = {}) {
    const mode = scanMode === "folder" && scanRoot ? "folder" : "local";
    const result = await discoverAiHistoryRoots({
      scanRoot: mode === "folder" ? scanRoot : undefined,
      scanMode: mode,
      quickValidate: mode === "local",
      onProgress: sendProgress,
    });
    const hasScopeChoice = result.roots.some((r) =>
      r.tool === "claude-code" || r.tool === "codex" || r.tool === "cursor",
    );
    authorizeDiscoveredRoots(result.roots, mode === "folder" ? result.scanRoot : null);
    return { ...result, hasScopeChoice, scanReport: result.scanReport || null };
  }

  safeHandle("pick-ai-history-scan-folder", async () => {
    const win = typeof _activeWindow === "function" ? _activeWindow() : null;
    const res = await dialog.showOpenDialog(win, openDialogOptions({
      title: "Select KAPE / triage / mounted disk folder",
      properties: ["openDirectory"],
      buttonLabel: "Select folder",
    }));
    if (res.canceled || !res.filePaths?.length) return { canceled: true };
    const picked = res.filePaths[0];
    authorizeAiScanTarget(picked, { label: "AI profile / triage collection" });
    return { path: picked };
  });

  safeHandle("discover-ai-history-profile", async (event, options = {}) => {
    const sendProgress = (patch) => safeSend("ai-history-profile-progress", patch);
    const { scanRoot, scanMode } = options;
    return runAiHistoryProfileDiscover(sendProgress, { scanRoot, scanMode });
  });

  safeHandle("extract-ai-history-profile", async (event, options = {}) => {
    const {
      includeSubagents,
      roots: clientRoots,
      discoverOnly = false,
      scanRoot,
      scanMode,
    } = options;
    const sendProgress = (patch) => safeSend("ai-history-profile-progress", patch);
    const collectionMode = scanMode === "folder" && scanRoot;

    if (discoverOnly) {
      return runAiHistoryProfileDiscover(sendProgress, { scanRoot, scanMode });
    }

    let roots = Array.isArray(clientRoots) ? clientRoots : null;
    let resolvedScanRoot = scanRoot;
    let resolvedScanMode = scanMode;
    let lastDiscover = null;
    if (!roots?.length) {
      lastDiscover = await runAiHistoryProfileDiscover(sendProgress, { scanRoot, scanMode });
      roots = lastDiscover.roots;
      resolvedScanRoot = lastDiscover.scanRoot || scanRoot;
      resolvedScanMode = lastDiscover.scanMode || scanMode;
    }

    // G4: when a collection root is set (folder browse or triage handoff), confine
    // extraction to that scope — reject forged/replayed roots outside the tree.
    if (resolvedScanRoot && roots?.length) {
      try {
        assertAiScanTarget(resolvedScanRoot);
      } catch (e) {
        return { error: e.message || "Collection folder is not authorized." };
      }
      const { allowed, rejected } = confineRootsToScope(roots, resolvedScanRoot);
      if (rejected.length) {
        dbg("EXEC", "ai-history: dropped out-of-scope roots", {
          count: rejected.length,
          scanRoot: resolvedScanRoot,
        });
      }
      roots = allowed;
    }

    try {
      authorizeDiscoveredRoots(roots, resolvedScanRoot || null);
      assertExtractRootsAuthorized(roots, resolvedScanRoot || null);
    } catch (e) {
      return { error: e.message || "AI artifact paths are not authorized." };
    }

    if (!roots.length) {
      const scanReport = lastDiscover?.scanReport || buildEmptyAiScanReport({
        scanRoot: resolvedScanRoot || scanRoot,
        scanMode: resolvedScanMode || scanMode,
        scanned: lastDiscover?.candidateCount || 0,
        hitsFound: 0,
      });
      return {
        error: scanReport.summary,
        scanReport,
      };
    }

    const hasScopeChoice = roots.some((r) =>
      r.tool === "claude-code" || r.tool === "codex" || r.tool === "cursor",
    );
    if (includeSubagents == null && hasScopeChoice) {
      return {
        needsScopeChoice: true,
        roots,
        scanRoot: resolvedScanRoot,
        scanMode: resolvedScanMode,
        hasScopeChoice: true,
      };
    }

    const useSubagents = !!includeSubagents;

    const user = os.userInfo().username || "";
    const host = os.hostname() || "";

    sendProgress({
      phase: "extracting",
      percent: 3,
      statusDetail: `Preparing ${roots.length} source(s)…`,
      logLine: roots.map((r) => `• ${r.label}: ${r.path}`).join("\n"),
      sourceCount: roots.length,
    });

    try {
      if (jobManager && db && nextTabId && _newTempDbPath) {
        const workerResult = await runAiHistoryProfileExtractWorker(ctx, roots, {
          safeSend,
          sendProgress,
          useSubagents,
          user,
          host,
          resolvedScanRoot,
          resolvedScanMode,
        });
        if (workerResult.error) return workerResult;
        dbg("EXEC", "extract-ai-history-profile (worker)", {
          roots: roots.length,
          rows: workerResult.count,
          failures: workerResult.failures?.length || 0,
        });
        return workerResult;
      }

      const abortToken = createAiHistoryExtractAbortToken();
      let rows;
      let importNotice;
      let failures;
      try {
        ({ rows, importNotice, failures } = await extractMergedAiHistoryRoots(
          roots,
          { user, host },
          {
            includeSubagents: useSubagents,
            skipFinalize: true,
            onProgress: (p) => sendProgress(p),
            checkAbort: () => abortToken.checkAbort(),
          },
        ));
      } finally {
        abortToken.dispose();
      }
      if (!rows.length) {
        const failDetail = failures.length
          ? failures.map((f) => `${f.label}: ${f.error}`).join("; ")
          : "Sources were found but contained no message rows.";
        return { error: failDetail };
      }

      sendProgress({
        phase: "complete",
        percent: 100,
        statusDetail: `Extracted ${rows.length.toLocaleString()} messages`,
        logLine: failures.length
          ? `Done with ${failures.length} source error(s) — opening timeline tab…`
          : "Done — opening merged AI Query History tab…",
        rowsSoFar: rows.length,
      });

      dbg("EXEC", "extract-ai-history-profile (main)", {
        roots: roots.length, rows: rows.length, failures: failures.length,
      });

      const sourcesLabel = roots.map((r) => r.label).join(", ");
      const collSuffix = resolvedScanRoot
        ? ` — ${path.basename(resolvedScanRoot)}`
        : "";
      return {
        rows,
        name: `AI Query History${collSuffix} (${rows.length.toLocaleString()})`,
        count: rows.length,
        sourceFormat: "ai-history-merged",
        importNotice,
        sources: roots.map((r) => ({ tool: r.tool, path: r.path, label: r.label })),
        failures,
        partial: failures.length > 0,
        sourcesLabel,
        scanRoot: resolvedScanRoot || null,
        scanMode: resolvedScanMode || "local",
      };
    } catch (e) {
      if (e instanceof AiHistoryExtractAbortedError || e?.canceled || e?.cancelled) {
        return { canceled: true };
      }
      return { error: `AI history profile scan failed: ${e.message}` };
    }
  });

  safeHandle("cancel-ai-history-extract", async () => {
    requestAiHistoryExtractAbort();
    if (jobManager) {
      jobManager.cancelWhere((job) => job.type === "ai-history-profile" || job.type === "ai-history-triage");
    }
    return { ok: true };
  });

  safeHandle("decode-external-artifact", async (event, { tool, path: inputPath } = {}) => {
    const cfg = getToolConfig(tool);
    if (!cfg) return { error: `Unknown artifact parser: ${tool}` };

    let target = inputPath;
    if (!target) {
      const win = typeof _activeWindow === "function" ? _activeWindow() : null;
      const properties = cfg.pick === "dir" ? ["openDirectory"] : ["openFile", "openDirectory"];
      const filters = cfg.fileExts.length ? [{ name: cfg.label, extensions: cfg.fileExts }] : undefined;
      const title = cfg.pick === "dir"
        ? `Select a folder of ${cfg.label}`
        : `Select a ${cfg.label} file or a folder`;
      const res = await dialog.showOpenDialog(win, openDialogOptions({ title, properties, filters, buttonLabel: "Decode" }));
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true };
      target = res.filePaths[0];
    }

    if (!resolveToolBinary(cfg.bin)) {
      return { error: `${cfg.bin} is not bundled with this build. Run \`npm run bundle:${cfg.bin}\` (or set ${envKeyFor(cfg.bin)}).` };
    }
    try {
      const csvPath = await runToolToCsv(tool, target);
      dbg("EXEC", "decode-external-artifact", { tool, target, csvPath });
      return { csvPath, name: path.basename(csvPath) };
    } catch (e) {
      return { error: `${cfg.label} decode failed: ${e.message}` };
    }
  });

  // ── Open Triage Collection (scan / parse split) ───────────────────────────────────────
  // scan-triage-folder: pick a folder, classify what's inside, return a selectable manifest.
  // parse-triage-folder: parse the user-selected kinds (heavy ones opt-in) + correlate execution.

  // Per-kind metadata: how it's parsed, whether it's heavy, and whether it's pre-checked.
  const KIND_META = {
    programExecution: { action: "correlate", heavy: false, recommended: true },
    prefetch: { action: "tool", heavy: false, recommended: true },
    lnk: { action: "tool", heavy: false, recommended: true },
    jumplist: { action: "tool", heavy: false, recommended: true },
    userHive: { action: "tool", heavy: false, recommended: true }, // shellbags
    amcache: { action: "native", heavy: false, recommended: true },
    recyclebin: { action: "timeline", heavy: false, recommended: true }, // deletion records; consumed by Build Super Timeline
    rdp: { action: "rdp", heavy: false, recommended: false },
    registryHive: { action: "native", heavy: true, recommended: false },
    mft: { action: "native", heavy: true, recommended: false },
    usn: { action: "native", heavy: true, recommended: false },
    evtx: { action: "sigma", heavy: true, recommended: false },
    aiClaude: { action: "ai", heavy: false, recommended: true },
    aiCodex: { action: "ai", heavy: false, recommended: true },
    aiChatgpt: { action: "ai", heavy: true, recommended: true }, // pre-selected when found; still marked heavy (large LevelDB/SQLite)
    aiGemini: { action: "ai", heavy: false, recommended: true },
    aiCursor: { action: "ai", heavy: false, recommended: true },
    aiCopilot: { action: "ai", heavy: false, recommended: true },
    aiWindsurf: { action: "ai", heavy: false, recommended: true },
    aiContinue: { action: "ai", heavy: false, recommended: true },
  };
  const MANIFEST_LABELS = {
    ...KIND_LABELS,
    ...AI_KIND_LABELS,
    userHive: "Shellbags (NTUSER/UsrClass)",
    registryHive: "Registry hives → Persistence",
    evtx: "EVTX logs → Sigma scan",
    rdp: "RDP bitmap cache",
    programExecution: "Program Execution (correlated)",
  };

  const mergeAiScan = (scan, aiScan) => {
    let total = scan.total || 0;
    const counts = { ...scan.counts };
    const bytes = { ...scan.bytes };
    const paths = { ...scan.paths };
    if (aiScan.claudeCode?.length) {
      counts.aiClaude = aiScan.claudeCode.length;
      bytes.aiClaude = 0;
      paths.aiClaude = aiScan.claudeCode.map((x) => x.path);
      total += aiScan.claudeCode.length;
    }
    if (aiScan.codex?.length) {
      counts.aiCodex = aiScan.codex.reduce((n, x) => n + (x.sessionCount || 1), 0);
      bytes.aiCodex = 0;
      paths.aiCodex = aiScan.codex.map((x) => x.path);
      total += aiScan.codex.length;
    }
    if (aiScan.chatgpt?.length) {
      counts.aiChatgpt = aiScan.chatgpt.length;
      bytes.aiChatgpt = 0;
      paths.aiChatgpt = aiScan.chatgpt.map((x) => x.path);
      total += aiScan.chatgpt.length;
    }
    if (aiScan.geminiCli?.length) {
      counts.aiGemini = aiScan.geminiCli.reduce((n, x) => n + (x.sessionCount || 1), 0);
      bytes.aiGemini = 0;
      paths.aiGemini = aiScan.geminiCli.map((x) => x.path);
      total += aiScan.geminiCli.length;
    }
    if (aiScan.cursor?.length) {
      counts.aiCursor = aiScan.cursor.reduce((n, x) => n + (x.sessionCount || 1), 0);
      bytes.aiCursor = 0;
      paths.aiCursor = aiScan.cursor.map((x) => x.path);
      total += aiScan.cursor.length;
    }
    if (aiScan.copilot?.length) {
      counts.aiCopilot = aiScan.copilot.reduce((n, x) => n + (x.sessionCount || 1), 0);
      bytes.aiCopilot = 0;
      paths.aiCopilot = aiScan.copilot.map((x) => x.path);
      total += aiScan.copilot.length;
    }
    if (aiScan.windsurf?.length) {
      counts.aiWindsurf = aiScan.windsurf.length;
      bytes.aiWindsurf = 0;
      paths.aiWindsurf = aiScan.windsurf.map((x) => x.path);
      total += aiScan.windsurf.length;
    }
    if (aiScan.continue?.length) {
      counts.aiContinue = aiScan.continue.reduce((n, x) => n + (x.sessionCount || 1), 0);
      bytes.aiContinue = 0;
      paths.aiContinue = aiScan.continue.map((x) => x.path);
      total += aiScan.continue.length;
    }
    if (total === scan.total) return scan;
    return { ...scan, counts, bytes, paths, total };
  };

  const buildManifest = (scan) => {
    const items = [];
    const hasExec = (scan.counts.amcache || 0) + (scan.counts.registryHive || 0) + (scan.counts.userHive || 0) + (scan.counts.prefetch || 0) > 0;
    if (hasExec) items.push({ kind: "programExecution", label: MANIFEST_LABELS.programExecution, count: null, bytes: 0, ...KIND_META.programExecution });
    for (const kind of ["aiClaude", "aiCodex", "aiChatgpt", "aiGemini", "aiCursor", "aiCopilot", "aiWindsurf", "aiContinue", "prefetch", "lnk", "jumplist", "userHive", "amcache", "recyclebin", "rdp", "registryHive", "evtx", "mft", "usn"]) {
      if (!scan.counts[kind]) continue;
      items.push({
        kind,
        label: MANIFEST_LABELS[kind] || kind,
        count: scan.counts[kind],
        bytes: scan.bytes[kind] || 0,
        ...KIND_META[kind],
      });
    }
    return items;
  };

  safeHandle("scan-triage-folder", async (event, { dir } = {}) => {
    let target = dir;
    if (!target) {
      const win = typeof _activeWindow === "function" ? _activeWindow() : null;
      const res = await dialog.showOpenDialog(win, openDialogOptions({ title: "Select a triage / KAPE collection folder", properties: ["openDirectory"], buttonLabel: "Scan" }));
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true };
      target = res.filePaths[0];
      authorizeAiScanTarget(target, { label: "Triage collection" });
    }
    try {
      assertAiScanTarget(target);
    } catch (e) {
      return { error: e.message || "Triage folder is not authorized." };
    }
    const scan = mergeAiScan(scanTriageDir(target), scanAiArtifacts(target));
    if (scan.total === 0) return { error: "No recognized Windows or AI artifacts found in this folder." };
    dbg("EXEC", "scan-triage-folder", { dir: target, manifest: scan.counts });
    return { dir: target, items: buildManifest(scan), truncated: scan.truncated };
  });

  safeHandle("parse-triage-folder", async (event, { dir, kinds, options } = {}) => {
    if (!dir) return { error: "No folder specified." };
    try {
      assertAiScanTarget(dir);
    } catch (e) {
      return { error: e.message || "Triage folder is not authorized." };
    }
    const selected = new Set(kinds || []);
    const dedupe = !!(options && options.dedupe);
    const scan = mergeAiScan(scanTriageDir(dir), scanAiArtifacts(dir));

    // Bundled tools (folder mode) for the selected file-artifact kinds.
    const TOOL_FOR_KIND = { prefetch: "prefetch", lnk: "lnk", jumplist: "jumplist", userHive: "shellbag" };
    const results = [];
    for (const [kind, toolKey] of Object.entries(TOOL_FOR_KIND)) {
      if (!selected.has(kind) || !scan.counts[kind]) continue;
      const cfg = getToolConfig(toolKey);
      if (!resolveToolBinary(cfg.bin)) { dbg("EXEC", "triage: tool not bundled", { toolKey }); continue; }
      try {
        const csvPath = await runToolToCsv(toolKey, dir, { isDir: true, dedupe });
        // Add per-row User/Host (derived from each SourceFile path) so the tab is attributable.
        try { fs.writeFileSync(csvPath, annotateCsvUserHost(fs.readFileSync(csvPath, "utf8"), dir, parseCSVLine)); }
        catch (e) { dbg("EXEC", "triage csv annotate failed", { toolKey, err: e.message }); }
        results.push({ label: cfg.label, csvPath, count: scan.counts[kind] });
      } catch (e) { dbg("EXEC", "triage: tool failed", { toolKey, err: e.message }); }
    }

    // Native imports (selected): Amcache + opt-in heavy registry hives / $MFT / $J.
    const natives = [];
    for (const kind of ["amcache", "registryHive", "mft", "usn"]) {
      if (selected.has(kind)) natives.push(...(scan.paths[kind] || []));
    }

    // Heavy artifacts that hand off to their existing flows.
    const launch = {};
    if (selected.has("evtx") && scan.paths.evtx && scan.paths.evtx.length) launch.sigmaDir = path.dirname(scan.paths.evtx[0]);
    if (selected.has("rdp") && scan.paths.rdp && scan.paths.rdp.length) launch.rdpPaths = scan.paths.rdp;

    // Program Execution correlation across every present execution source.
    let programExecution = null;
    if (selected.has("programExecution")) {
      const execSources = { amcache: [], shimcache: [], userassist: [], prefetch: [] };
      const readBuf = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
      const byBase = (kind, name) => (scan.paths[kind] || []).filter((h) => path.basename(h).toUpperCase() === name);
      for (const p of scan.paths.amcache || []) { const buf = readBuf(p); if (!buf) continue; const host = deriveHost(p, dir); try { execSources.amcache.push(...fromAmcacheRows(parseAmcacheBuffer(buf, { sourceName: path.basename(p) }).rows).map((r) => ({ ...r, host }))); } catch (e) { dbg("EXEC", "triage amcache failed", { err: e.message }); } }
      for (const p of byBase("registryHive", "SYSTEM")) { const buf = readBuf(p); if (!buf) continue; const host = deriveHost(p, dir); try { const sc = parseShimCacheFromHive(buf, { sourceName: path.basename(p) }); if (sc.rows.length) execSources.shimcache.push(...fromShimcacheRows(sc.rows).map((r) => ({ ...r, host }))); } catch (e) { dbg("EXEC", "triage shimcache failed", { err: e.message }); } }
      for (const p of byBase("userHive", "NTUSER.DAT")) { const buf = readBuf(p); if (!buf) continue; const user = deriveUser(p), host = deriveHost(p, dir); try { const ua = parseUserAssistBuffer(buf, { sourceName: path.basename(p) }); if (ua.rows.length) execSources.userassist.push(...fromUserassistRows(ua.rows).map((r) => ({ ...r, user, host }))); } catch (e) { dbg("EXEC", "triage userassist failed", { err: e.message }); } }
      const pfResult = results.find((r) => r.label === getToolConfig("prefetch").label);
      if (pfResult) { const buf = readBuf(pfResult.csvPath); if (buf) { try { execSources.prefetch.push(...fromPrefetchCsv(buf.toString("utf8"))); } catch (e) { dbg("EXEC", "triage prefetch csv failed", { err: e.message }); } } }
      if (execSources.amcache.length || execSources.shimcache.length || execSources.userassist.length || execSources.prefetch.length) {
        const rows = correlateExecution(execSources);
        const contributors = Object.entries(execSources).filter(([, v]) => v.length).map(([k]) => k);
        programExecution = { rows, name: `Program Execution (${rows.length})`, contributors };
      }
    }

    const mergeAiHistory = options?.mergeAiHistory !== false;
    const hasAiSelected = AI_TRIAGE_SOURCES.some((s) => selected.has(s.kind));
    const needsScopeChoice = hasAiSelected && triageSelectedHasScopeChoice(selected)
      && options?.includeSubagents == null;

    if (needsScopeChoice) {
      return {
        needsScopeChoice: true,
        results,
        natives,
        programExecution,
        aiHistory: null,
        aiHistories: [],
        aiTabsOpened: [],
        launch,
      };
    }

    const includeSubagents = triageSelectedHasScopeChoice(selected)
      ? !!options?.includeSubagents
      : false;

    let aiHistories = [];
    let aiHistory = null;
    let aiTabsOpened = [];
    let aiExtractError = null;

    if (hasAiSelected) {
      const aiResult = await runTriageAiExtraction(
        { db, jobManager, nextTabId, _newTempDbPath, scheduleIndexBuild, _tabMeta, safeSend },
        scan,
        dir,
        selected,
        { mergeAiHistory, includeSubagents },
      );
      if (aiResult?.error) aiExtractError = aiResult.error;
      aiHistories = aiResult.aiHistories || [];
      aiHistory = aiResult.aiHistory || null;
      aiTabsOpened = aiResult.aiTabsOpened || [];
    }

    dbg("EXEC", "parse-triage-folder", {
      dir, selected: [...selected], results: results.length, natives: natives.length, launch,
      pe: programExecution?.rows.length || 0,
      ai: aiHistories.reduce((n, h) => n + (h.rows?.length || 0), 0)
        + aiTabsOpened.reduce((n, t) => n + (t.count || 0), 0),
      aiWorkerTabs: aiTabsOpened.length,
    });

    const out = {
      results,
      natives,
      programExecution,
      aiHistory,
      aiHistories,
      aiTabsOpened,
      launch,
    };
    if (aiExtractError) out.aiExtractError = aiExtractError;
    return out;
  });
};
