/**
 * claude-desktop.js — Claude Desktop claude-code-sessions metadata + CLI JSONL bridge.
 *
 * Desktop stores local_<uuid>.json index files; transcripts live under ~/.claude/projects/.
 */

const fs = require("fs");
const path = require("path");

const { dbg } = require("../../logger");
const { TOOL_CLAUDE_CODE } = require("./schema");
const { tickFileProgress } = require("./extract-plan");
const {
  isClaudeDesktopSessionsRoot,
  CLAUDE_DIR_NAME,
} = require("./artifact-paths");
const {
  extractSessionFile,
  listSessionJsonlFiles,
} = require("./claude-code");
const {
  formatTimestampUtc,
  makeRow,
  finalizeAiHistoryRows,
} = require("./row-utils");

const LOCAL_META_RE = /^local_.*\.json$/i;

function isNullJsonFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (!buf.length) return true;
    const nonZero = buf.find((b) => b !== 0);
    return nonZero === undefined;
  } catch {
    return true;
  }
}

function parseDesktopMetadataFile(filePath) {
  if (isNullJsonFile(filePath)) return null;
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); } catch { return null; }
  const trimmed = raw.replace(/\0/g, "").trim();
  if (!trimmed) return null;
  let obj;
  try { obj = JSON.parse(trimmed); } catch {
    dbg("AIHIST", "claude desktop metadata parse failed", { filePath });
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  return obj;
}

function normalizeCliSessionId(meta) {
  let id = meta.cliSessionId != null ? String(meta.cliSessionId).trim() : "";
  if (!id && meta.sessionId != null) {
    const sid = String(meta.sessionId).trim();
    if (sid.startsWith("local_")) id = sid.slice("local_".length);
    else if (!sid.startsWith("local")) id = sid;
  }
  return id.replace(/\.jsonl$/i, "");
}

function listDesktopMetadataFiles(rootDir, maxDepth = 12) {
  const out = [];
  const stack = [{ d: rootDir, depth: 0 }];
  while (stack.length) {
    const { d, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < maxDepth && !e.isSymbolicLink()) {
        stack.push({ d: full, depth: depth + 1 });
      } else if (e.isFile() && LOCAL_META_RE.test(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Resolve ~/.claude next to a Desktop sessions tree (same user profile). */
function resolveClaudeProjectsDir(desktopRoot, extraSearchRoots = []) {
  const candidates = [];
  const push = (p) => { if (p && !candidates.includes(p)) candidates.push(p); };

  for (const root of extraSearchRoots) {
    push(path.join(root, CLAUDE_DIR_NAME, "projects"));
    push(path.join(root, ".claude", "projects"));
  }

  let p = path.resolve(desktopRoot);
  for (let i = 0; i < 24; i++) {
    push(path.join(p, CLAUDE_DIR_NAME, "projects"));
    const base = path.basename(p);
    if (base === CLAUDE_DIR_NAME) {
      push(path.join(p, "projects"));
      break;
    }
    if (/^Users$/i.test(base) || base === "home") {
      try {
        const users = fs.readdirSync(p, { withFileTypes: true });
        for (const u of users) {
          if (!u.isDirectory()) continue;
          push(path.join(p, u.name, CLAUDE_DIR_NAME, "projects"));
          push(path.join(p, u.name, ".claude", "projects"));
        }
      } catch { /* ignore */ }
    }
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }

  const homedir = require("os").homedir();
  push(path.join(homedir, CLAUDE_DIR_NAME, "projects"));

  for (const projectsDir of candidates) {
    if (projectsDir && fs.existsSync(projectsDir)) return projectsDir;
  }
  return null;
}

function buildJsonlIndex(projectsDir) {
  const index = new Map();
  if (!projectsDir) return index;
  for (const jsonlPath of listSessionJsonlFiles(projectsDir, { includeSubagents: true })) {
    const id = path.basename(jsonlPath, ".jsonl");
    if (id && !index.has(id)) index.set(id, jsonlPath);
  }
  return index;
}

function metadataSummaryRow(meta, metaPath, attribution) {
  const title = meta.title != null ? String(meta.title).trim() : "";
  const model = meta.model != null ? String(meta.model) : "";
  const cwd = meta.cwd || meta.originCwd || "";
  const tsMs = Number(meta.lastActivityAt) || Number(meta.createdAt) || null;
  const sessionId = meta.sessionId != null ? String(meta.sessionId) : "";
  const cliId = normalizeCliSessionId(meta);
  let summary = title || "[Claude Desktop session]";
  if (!meta.cliSessionId && cliId) summary += " (no cliSessionId — transcript link uncertain)";

  return makeRow({
    timestamp: tsMs != null && Number.isFinite(tsMs) ? formatTimestampUtc(tsMs) : "",
    role: "session",
    recordType: "desktop-metadata",
    summary,
    sessionId: cliId || sessionId,
    messageId: sessionId,
    workspace: cwd ? String(cwd) : "",
    model,
    sourceFile: metaPath,
    user: attribution.user || "",
    host: attribution.host || "",
    tool: TOOL_CLAUDE_CODE,
  }, TOOL_CLAUDE_CODE);
}

/**
 * @returns {{ rows: object[], stats: object }}
 */
async function extractClaudeDesktopDir(desktopRoot, attribution = {}, options = {}) {
  const metaFiles = listDesktopMetadataFiles(desktopRoot);
  const projectsDir = resolveClaudeProjectsDir(desktopRoot, options.claudeProjectsSearchRoots || []);
  const jsonlIndex = buildJsonlIndex(projectsDir);
  const rows = [];
  const stats = {
    metadataFiles: metaFiles.length,
    linkedTranscripts: 0,
    metadataOnly: 0,
    danglingCli: 0,
    corruptMetadata: 0,
    transcriptRows: 0,
  };

  let fileIndex = 0;
  const fileCount = metaFiles.length;
  const { onFileProgress } = options;

  for (const metaPath of metaFiles) {
    fileIndex += 1;
    tickFileProgress(onFileProgress, fileIndex, fileCount, metaPath);

    const meta = parseDesktopMetadataFile(metaPath);
    if (!meta) {
      stats.corruptMetadata += 1;
      continue;
    }

    const cliId = normalizeCliSessionId(meta);
    const jsonlPath = cliId ? jsonlIndex.get(cliId) : null;

    if (jsonlPath) {
      try {
        const sessionRows = await extractSessionFile(jsonlPath, {
          ...attribution,
          desktopTitle: meta.title,
          desktopModel: meta.model,
        });
        for (const r of sessionRows) {
          if (meta.title && !r.Workspace) r.Workspace = String(meta.cwd || meta.originCwd || "");
          if (meta.model && !r.Model) r.Model = String(meta.model);
        }
        rows.push(...sessionRows);
        stats.linkedTranscripts += 1;
        stats.transcriptRows += sessionRows.length;
      } catch (e) {
        dbg("AIHIST", "claude desktop linked jsonl failed", { metaPath, jsonlPath, err: e.message });
        rows.push(metadataSummaryRow(meta, metaPath, attribution));
        stats.danglingCli += 1;
      }
    } else {
      rows.push(metadataSummaryRow(meta, metaPath, attribution));
      if (cliId) stats.danglingCli += 1;
      else stats.metadataOnly += 1;
    }

    if (fileIndex % 6 === 0) await new Promise((r) => setImmediate(r));
    if (typeof options.checkAbort === "function") options.checkAbort();
  }

  if (!rows.length && metaFiles.length === 0) {
    const orphanJsonl = projectsDir
      ? listSessionJsonlFiles(projectsDir, options).length
      : 0;
    stats.orphanJsonlHint = orphanJsonl;
  }

  return {
    rows: finalizeAiHistoryRows(rows, options),
    stats,
    projectsDir,
  };
}

function buildClaudeDesktopImportNotice(stats) {
  if (!stats) return "";
  const parts = [];
  if (stats.linkedTranscripts > 0) {
    parts.push(`Claude Desktop: ${stats.linkedTranscripts} session(s) linked to CLI transcripts (${stats.transcriptRows} row(s))`);
  }
  if (stats.danglingCli > 0) {
    parts.push(`${stats.danglingCli} metadata file(s) reference missing ~/.claude/projects JSONL — collect the user's .claude folder`);
  }
  if (stats.metadataOnly > 0) {
    parts.push(`${stats.metadataOnly} metadata file(s) without cliSessionId (titles only)`);
  }
  if (stats.metadataFiles > 0 && stats.linkedTranscripts === 0 && stats.danglingCli === 0 && stats.metadataOnly === stats.metadataFiles) {
    return "Claude Desktop: session metadata found but no CLI transcripts — also import ~/.claude/projects for message bodies.";
  }
  if (stats.metadataFiles === 0 && stats.orphanJsonlHint > 0) {
    return `Claude Desktop folder has no local_*.json index; ${stats.orphanJsonlHint} JSONL file(s) exist under .claude/projects on this host.`;
  }
  return parts.join("; ");
}

module.exports = {
  listDesktopMetadataFiles,
  parseDesktopMetadataFile,
  normalizeCliSessionId,
  resolveClaudeProjectsDir,
  extractClaudeDesktopDir,
  buildClaudeDesktopImportNotice,
  isClaudeDesktopSessionsRoot,
};
