// Hierarchical process graph layout for the Process Inspector.
//
// Pure layout: inputs are process nodes + detection map (+ optional focus keys).
// Output is positioned nodes/edges suitable for SVG rendering — no DOM.
//
// Design goals:
//   • Multi-root / multi-host campaigns readable as host swimlanes
//   • Cap node count so fleet timelines stay interactive
//   • Prefer suspicious + ancestry + direct children over "render everything"
//   • Respect consistentParentKey so PID-reuse mislinks don't pull wrong subtrees

import { consistentParentKey } from "./process-inspector-pipeline.js";

export const PROCESS_GRAPH_DEFAULTS = {
  maxNodes: 220,
  nodeWidth: 196,
  // Minimum card height; actual height grows to fit wrapped labels (no truncation).
  nodeHeight: 48,
  colGap: 48,
  rowGap: 16,
  hostGap: 36,
  padX: 40,
  padY: 32,
  // Typography used to estimate wrap so layout height matches the renderer.
  titleFontSize: 12,
  titleLineHeight: 16,
  subFontSize: 9,
  subLineHeight: 12,
  // Approx monospace advance (px) — SF Mono / Menlo at the sizes above.
  titleCharWidth: 7.2,
  subCharWidth: 5.5,
  // Inner horizontal padding: accent bar + gutters + icon column.
  contentPadX: 36,
  contentPadY: 12,
  maxTitleLines: 6,
  maxSubLines: 4,
};

const _procBase = (p) => String(p?.processName || p?.image || "(unknown)").split(/[/\\]/).pop() || "(unknown)";

/** Soft-wrap a string into lines that fit `maxChars` (word-aware, then hard-break). */
export const wrapTextLines = (text, maxChars, maxLines = 20) => {
  const raw = String(text || "").trim();
  if (!raw) return [""];
  const limit = Math.max(4, Math.floor(maxChars));
  const lines = [];
  // Prefer splitting on path/backslash/space/dot boundaries so long names stay readable.
  const tokens = raw.split(/(\s+|\\+|\/+|[._-]+)/).filter((t) => t.length > 0);
  let cur = "";
  const push = (s) => {
    if (lines.length >= maxLines) return;
    lines.push(s);
  };
  const flush = () => {
    if (cur) { push(cur); cur = ""; }
  };
  for (const tok of tokens) {
    if (lines.length >= maxLines) break;
    if (!cur) {
      if (tok.length <= limit) { cur = tok; continue; }
      // Hard-break oversized token
      for (let i = 0; i < tok.length && lines.length < maxLines; i += limit) {
        const chunk = tok.slice(i, i + limit);
        if (i + limit < tok.length && lines.length === maxLines - 1) {
          push(chunk); // last line — full chunk, no ellipsis (height will grow instead)
        } else {
          push(chunk);
        }
      }
      cur = "";
      continue;
    }
    if (cur.length + tok.length <= limit) {
      cur += tok;
    } else {
      flush();
      if (tok.length <= limit) cur = tok;
      else {
        for (let i = 0; i < tok.length && lines.length < maxLines; i += limit) {
          push(tok.slice(i, i + limit));
        }
      }
    }
  }
  flush();
  return lines.length ? lines : [""];
};

/** Build the secondary meta line shown under the process name. */
export const buildNodeSubLine = (n) => {
  const parts = [];
  if (n?.pid) parts.push(`PID ${n.pid}`);
  if (n?.level > 0) parts.push(`L${n.level}`);
  if (n?.user) parts.push(n.user);
  return parts.join(" · ") || "—";
};

/**
 * Estimate card height so the full process name + meta fit without truncation.
 * Pure; kept in lockstep with ProcessGraphView typography.
 */
export const estimateNodeHeight = (processName, subLine, cfg = PROCESS_GRAPH_DEFAULTS) => {
  const contentW = Math.max(40, (cfg.nodeWidth || 196) - (cfg.contentPadX || 36));
  const titleChars = Math.max(4, Math.floor(contentW / (cfg.titleCharWidth || 7.2)));
  // Icon takes ~19px on the first title row; subsequent title wrap uses full width.
  // Use full width for estimate (slightly conservative height is fine).
  const titleLines = wrapTextLines(processName, titleChars, cfg.maxTitleLines || 6);
  const subChars = Math.max(4, Math.floor(contentW / (cfg.subCharWidth || 5.5)));
  const subLines = wrapTextLines(subLine, subChars, cfg.maxSubLines || 4);
  const titleH = titleLines.length * (cfg.titleLineHeight || 16);
  const subH = subLines.length * (cfg.subLineHeight || 12);
  const gap = 2;
  const padY = cfg.contentPadY || 12;
  const minH = cfg.nodeHeight || 48;
  return Math.max(minH, padY + titleH + gap + subH);
};

/**
 * Choose which process keys should seed the graph.
 *
 * Priority:
 *   1. Explicit focusKeys (story/cluster/selection context)
 *   2. Detected processes (level >= minLevel), highest triage score first
 *   3. Fallback: earliest processes (raw exploration)
 */
export const selectGraphSeedKeys = (processes, detMap, opts = {}) => {
  const {
    focusKeys = null,
    minLevel = 1,
    maxSeeds = 80,
  } = opts;
  if (!processes?.length) return [];

  if (focusKeys && focusKeys.size > 0) {
    const out = [];
    for (const k of focusKeys) {
      out.push(k);
      if (out.length >= maxSeeds) break;
    }
    return out;
  }

  const scored = [];
  for (const p of processes) {
    const det = detMap?.get?.(p.key) || { level: 0, triageScore: 0 };
    if ((det.level || 0) < minLevel) continue;
    scored.push({
      key: p.key,
      level: det.level || 0,
      triage: det.triageScore || 0,
      tsMs: Number.isFinite(p.tsMs) ? p.tsMs : Number.MAX_SAFE_INTEGER,
    });
  }
  scored.sort((a, b) =>
    b.level - a.level
    || b.triage - a.triage
    || a.tsMs - b.tsMs
  );

  if (scored.length > 0) {
    return scored.slice(0, maxSeeds).map((s) => s.key);
  }

  // No detections — show a small chronological sample so Graph mode still works.
  const sample = [...processes]
    .sort((a, b) => (Number.isFinite(a.tsMs) ? a.tsMs : 0) - (Number.isFinite(b.tsMs) ? b.tsMs : 0))
    .slice(0, Math.min(40, maxSeeds));
  return sample.map((p) => p.key);
};

/**
 * Expand seed keys to a connected subgraph: seeds + ancestors + direct children.
 * Caps at maxNodes; prefers keeping higher-severity nodes when truncating.
 */
export const buildGraphSubgraph = (processes, detMap, seedKeys, opts = {}) => {
  const maxNodes = opts.maxNodes ?? PROCESS_GRAPH_DEFAULTS.maxNodes;
  const includeChildren = opts.includeChildren !== false;
  const includeAncestors = opts.includeAncestors !== false;
  if (!processes?.length || !seedKeys?.length) {
    return { keys: new Set(), truncated: false, seedCount: 0 };
  }

  const byKey = opts.byKey || new Map(processes.map((p) => [p.key, p]));
  const childMap = opts.childMap || (() => {
    const m = new Map();
    for (const p of processes) {
      if (!p.parentKey) continue;
      if (!m.has(p.parentKey)) m.set(p.parentKey, []);
      m.get(p.parentKey).push(p.key);
    }
    return m;
  })();

  const keep = new Set();
  const add = (key) => {
    if (!key || !byKey.has(key) || keep.has(key)) return false;
    if (keep.size >= maxNodes) return false;
    keep.add(key);
    return true;
  };

  // Seeds first
  for (const k of seedKeys) add(k);

  // Ancestors (via consistentParentKey)
  if (includeAncestors) {
    for (const seed of seedKeys) {
      let cur = byKey.get(seed);
      let hops = 0;
      while (cur && hops++ < 32) {
        const pk = consistentParentKey(cur, byKey);
        if (!pk || !byKey.has(pk)) break;
        if (!add(pk)) break;
        cur = byKey.get(pk);
      }
    }
  }

  // Direct children of seeds (and of already-included nodes that are detected)
  if (includeChildren) {
    const childCandidates = [];
    for (const k of keep) {
      for (const ck of (childMap.get(k) || [])) {
        if (keep.has(ck)) continue;
        const det = detMap?.get?.(ck) || { level: 0, triageScore: 0 };
        childCandidates.push({
          key: ck,
          level: det.level || 0,
          triage: det.triageScore || 0,
        });
      }
    }
    // Prefer suspicious children when space is tight
    childCandidates.sort((a, b) => b.level - a.level || b.triage - a.triage);
    for (const c of childCandidates) {
      if (keep.size >= maxNodes) break;
      add(c.key);
    }
  }

  const truncated = seedKeys.some((k) => !keep.has(k)) || keep.size >= maxNodes;
  return { keys: keep, truncated, seedCount: seedKeys.length, byKey, childMap };
};

/**
 * Assign layered (depth) positions within host lanes.
 * Returns { nodes, edges, width, height, hosts, stats }.
 */
export const layoutProcessGraph = (processes, detMap, opts = {}) => {
  const cfg = { ...PROCESS_GRAPH_DEFAULTS, ...opts };
  const procs = processes || [];
  if (!procs.length) {
    return {
      nodes: [],
      edges: [],
      width: cfg.padX * 2,
      height: cfg.padY * 2,
      hosts: [],
      stats: { total: 0, rendered: 0, truncated: false, seeds: 0 },
    };
  }

  const byKey = opts.byKey || new Map(procs.map((p) => [p.key, p]));
  const childMap = opts.childMap || (() => {
    const m = new Map();
    for (const p of procs) {
      if (!p.parentKey) continue;
      if (!m.has(p.parentKey)) m.set(p.parentKey, []);
      m.get(p.parentKey).push(p.key);
    }
    return m;
  })();

  const minLevel = opts.minLevel ?? 1;
  const focusKeys = opts.focusKeys || null;
  const seedKeys = opts.seedKeys || selectGraphSeedKeys(procs, detMap, {
    focusKeys,
    minLevel,
    maxSeeds: opts.maxSeeds ?? 80,
  });

  const sub = buildGraphSubgraph(procs, detMap, seedKeys, {
    maxNodes: cfg.maxNodes,
    byKey,
    childMap,
    includeChildren: opts.includeChildren,
    includeAncestors: opts.includeAncestors,
  });

  // Depth relative to subgraph roots (not global tree depth)
  const depthMap = new Map();
  const subgraphParent = (node) => {
    const pk = consistentParentKey(node, byKey);
    if (!pk || !sub.keys.has(pk)) return null;
    return pk;
  };

  // Roots = nodes whose consistent parent is outside the subgraph
  const roots = [];
  for (const k of sub.keys) {
    const n = byKey.get(k);
    if (!n) continue;
    if (!subgraphParent(n)) roots.push(n);
  }

  // BFS depth
  const queue = [];
  for (const r of roots) {
    depthMap.set(r.key, 0);
    queue.push(r.key);
  }
  let qi = 0;
  while (qi < queue.length) {
    const k = queue[qi++];
    const d = depthMap.get(k) || 0;
    for (const ck of (childMap.get(k) || [])) {
      if (!sub.keys.has(ck) || depthMap.has(ck)) continue;
      // Only walk edges that match consistentParentKey
      const child = byKey.get(ck);
      if (!child || subgraphParent(child) !== k) continue;
      depthMap.set(ck, d + 1);
      queue.push(ck);
    }
  }
  // Orphans that weren't reached (cycles / broken links) — place as roots
  for (const k of sub.keys) {
    if (!depthMap.has(k)) {
      depthMap.set(k, 0);
      roots.push(byKey.get(k));
    }
  }

  // Group roots by host for swimlanes
  const hostOf = (n) => String(n?.normHost || n?.hostname || "").trim() || "(no host)";
  const hostOrder = [];
  const hostRoots = new Map();
  const seenHost = new Set();
  // Sort roots: host, then severity, then time
  const rootScore = (n) => {
    const det = detMap?.get?.(n.key) || { level: 0, triageScore: 0 };
    return { level: det.level || 0, triage: det.triageScore || 0, ts: Number.isFinite(n.tsMs) ? n.tsMs : 0 };
  };
  roots.sort((a, b) => {
    const ha = hostOf(a);
    const hb = hostOf(b);
    if (ha !== hb) return ha.localeCompare(hb);
    const sa = rootScore(a);
    const sb = rootScore(b);
    return sb.level - sa.level || sb.triage - sa.triage || sa.ts - sb.ts;
  });
  for (const r of roots) {
    const h = hostOf(r);
    if (!seenHost.has(h)) {
      seenHost.add(h);
      hostOrder.push(h);
      hostRoots.set(h, []);
    }
    hostRoots.get(h).push(r);
  }

  // Pixel-space placement: leaf-pack vertically with variable card heights so
  // wrapped process names / user strings never need truncation.
  const nodesOut = [];
  const pos = new Map(); // key -> { depth, y, height, host }
  const maxDepthSeen = { n: 0 };
  const { nodeWidth, colGap, rowGap, padX, padY, hostGap } = cfg;

  const measureKey = (key) => {
    const n = byKey.get(key);
    if (!n) return cfg.nodeHeight || 48;
    const det = detMap?.get?.(key) || { level: 0 };
    const processName = _procBase(n);
    const subLine = buildNodeSubLine({ pid: n.pid, user: n.user, level: det.level || 0 });
    return estimateNodeHeight(processName, subLine, cfg);
  };

  const placeTree = (key, depth, host, counter) => {
    if (!sub.keys.has(key) || pos.has(key)) return;
    const node = byKey.get(key);
    if (!node) return;
    const kids = (childMap.get(key) || [])
      .filter((ck) => sub.keys.has(ck) && !pos.has(ck))
      .filter((ck) => {
        const child = byKey.get(ck);
        return child && subgraphParent(child) === key;
      })
      .map((ck) => byKey.get(ck))
      .filter(Boolean)
      .sort((a, b) => {
        const sa = rootScore(a);
        const sb = rootScore(b);
        return sb.level - sa.level || sa.ts - sb.ts;
      });

    const height = measureKey(key);
    if (kids.length === 0) {
      const y = counter.y;
      counter.y += height + rowGap;
      pos.set(key, { depth, y, height, host });
      if (depth > maxDepthSeen.n) maxDepthSeen.n = depth;
      return;
    }
    for (const kid of kids) placeTree(kid.key, depth + 1, host, counter);
    // Center parent on the span of its children.
    const childPos = kids.map((k) => pos.get(k.key)).filter(Boolean);
    let y;
    if (childPos.length) {
      const top = Math.min(...childPos.map((p) => p.y));
      const bot = Math.max(...childPos.map((p) => p.y + p.height));
      y = (top + bot) / 2 - height / 2;
      // Don't climb above the first child (keeps host lanes tidy).
      if (y < top) y = top;
    } else {
      y = counter.y;
      counter.y += height + rowGap;
    }
    pos.set(key, { depth, y, height, host });
    if (depth > maxDepthSeen.n) maxDepthSeen.n = depth;
  };

  let hostLaneY = 0;
  for (const host of hostOrder) {
    const counter = { y: 0 };
    for (const r of hostRoots.get(host) || []) {
      placeTree(r.key, 0, host, counter);
    }
    const laneKeys = [...pos.entries()].filter(([, p]) => p.host === host);
    if (laneKeys.length === 0) continue;
    const minY = Math.min(...laneKeys.map(([, p]) => p.y));
    const maxY = Math.max(...laneKeys.map(([, p]) => p.y + p.height));
    const shift = hostLaneY - minY;
    for (const [k, p] of laneKeys) {
      pos.set(k, { ...p, y: p.y + shift });
    }
    hostLaneY = maxY + shift + (hostGap || 36);
  }

  let maxX = 0;
  let maxY = 0;
  for (const k of sub.keys) {
    const n = byKey.get(k);
    if (!n) continue;
    const det = detMap?.get?.(k) || { level: 0, reason: null, triageScore: 0 };
    const processName = _procBase(n);
    const height = measureKey(k);
    const p = pos.get(k) || { depth: 0, y: hostLaneY, height, host: hostOf(n) };
    const x = padX + p.depth * (nodeWidth + colGap);
    const y = padY + p.y;
    if (x + nodeWidth > maxX) maxX = x + nodeWidth;
    if (y + (p.height || height) > maxY) maxY = y + (p.height || height);
    nodesOut.push({
      key: k,
      x,
      y,
      width: nodeWidth,
      height: p.height || height,
      depth: p.depth,
      host: p.host,
      processName,
      pid: n.pid || "",
      user: n.user || "",
      ts: n.ts || "",
      image: n.image || "",
      cmdLine: n.cmdLine || "",
      level: det.level || 0,
      reason: det.reason || null,
      triageScore: det.triageScore || 0,
      isSeed: seedKeys.includes(k),
      childCount: n.childCount || 0,
      rowid: n.rowid,
    });
  }

  // Edges — only consistent parent links inside subgraph
  const edges = [];
  for (const n of nodesOut) {
    const src = byKey.get(n.key);
    if (!src) continue;
    const pk = subgraphParent(src);
    if (!pk) continue;
    const parentPos = nodesOut.find((x) => x.key === pk);
    if (!parentPos) continue;
    const link = src.link || null;
    edges.push({
      id: `${pk}->${n.key}`,
      source: pk,
      target: n.key,
      // source right-center → target left-center
      x1: parentPos.x + parentPos.width,
      y1: parentPos.y + parentPos.height / 2,
      x2: n.x,
      y2: n.y + n.height / 2,
      level: Math.max(parentPos.level, n.level),
      confidence: link?.confidence || src.linkConfidence || "",
      sourceKind: link?.source || src.linkSource || "",
    });
  }

  // Host labels (left of first root in each host)
  const hosts = hostOrder.map((host) => {
    const hostNodes = nodesOut.filter((n) => n.host === host);
    if (!hostNodes.length) return { host, y: 0, height: 0, count: 0 };
    const minY = Math.min(...hostNodes.map((n) => n.y));
    const maxY = Math.max(...hostNodes.map((n) => n.y + n.height));
    return { host, y: minY, height: maxY - minY, count: hostNodes.length };
  }).filter((h) => h.count > 0);

  return {
    nodes: nodesOut,
    edges,
    width: maxX + padX,
    height: maxY + padY,
    hosts,
    stats: {
      total: procs.length,
      rendered: nodesOut.length,
      truncated: sub.truncated || nodesOut.length >= cfg.maxNodes,
      seeds: seedKeys.length,
      hosts: hosts.length,
      maxDepth: maxDepthSeen.n,
    },
  };
};
