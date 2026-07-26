import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildNodeSubLine, layoutProcessGraph } from "../../../utils/process-graph-layout.js";

/**
 * SVG node-link process graph with pan/zoom.
 * Click a node to select; detail panel is owned by the parent modal.
 */
export default function ProcessGraphView({
  processes,
  detMap,
  byKeyMap,
  childMap,
  selectedKey,
  focusKeys = null,
  minLevel = 1,
  th,
  sevColors,
  onSelect,
  ptIcon,
}) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const dragRef = useRef(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      setSize({ w: Math.max(200, cr.width), h: Math.max(200, cr.height) });
    });
    ro.observe(el);
    setSize({ w: Math.max(200, el.clientWidth), h: Math.max(200, el.clientHeight) });
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => layoutProcessGraph(processes, detMap, {
    byKey: byKeyMap,
    childMap,
    focusKeys,
    minLevel,
    maxNodes: 220,
  }), [processes, detMap, byKeyMap, childMap, focusKeys, minLevel]);

  // Fit graph into viewport when layout identity changes
  useEffect(() => {
    if (!layout.nodes.length || size.w < 40 || size.h < 40) return;
    const pad = 48;
    const sx = (size.w - pad * 2) / Math.max(layout.width, 1);
    const sy = (size.h - pad * 2) / Math.max(layout.height, 1);
    const k = Math.max(0.15, Math.min(1.15, Math.min(sx, sy)));
    const x = (size.w - layout.width * k) / 2;
    const y = Math.max(12, (size.h - layout.height * k) / 2);
    setView({ x, y, k });
  }, [layout, size.w, size.h]);

  // Pan selected node into view (soft)
  useEffect(() => {
    if (!selectedKey || !layout.nodes.length) return;
    const n = layout.nodes.find((x) => x.key === selectedKey);
    if (!n) return;
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    setView((v) => {
      const sx = cx * v.k + v.x;
      const sy = cy * v.k + v.y;
      const margin = 80;
      let nx = v.x;
      let ny = v.y;
      if (sx < margin) nx += margin - sx;
      else if (sx > size.w - margin) nx -= sx - (size.w - margin);
      if (sy < margin) ny += margin - sy;
      else if (sy > size.h - margin) ny -= sy - (size.h - margin);
      if (nx === v.x && ny === v.y) return v;
      return { ...v, x: nx, y: ny };
    });
  }, [selectedKey, layout, size.w, size.h]);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => {
      const k = Math.max(0.12, Math.min(2.5, v.k * factor));
      // Zoom toward cursor
      const x = mx - (mx - v.x) * (k / v.k);
      const y = my - (my - v.y) * (k / v.k);
      return { x, y, k };
    });
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    // Don't start pan when clicking a node (nodes stopPropagation)
    dragRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = () => { dragRef.current = null; };

  const resetView = () => {
    if (!layout.nodes.length) return;
    const pad = 48;
    const sx = (size.w - pad * 2) / Math.max(layout.width, 1);
    const sy = (size.h - pad * 2) / Math.max(layout.height, 1);
    const k = Math.max(0.15, Math.min(1.15, Math.min(sx, sy)));
    setView({ x: (size.w - layout.width * k) / 2, y: Math.max(12, (size.h - layout.height * k) / 2), k });
  };

  const levelColor = (lv) => {
    if (lv >= 3) return sevColors?.[3] || th.sev.critical;
    if (lv >= 2) return sevColors?.[2] || th.sev.high;
    if (lv >= 1) return sevColors?.[1] || th.sev.med;
    return th.border;
  };

  return (
    <div ref={wrapRef} style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative", overflow: "hidden", background: `radial-gradient(ellipse at 30% 20%, ${th.accent}08 0%, transparent 55%), ${th.modalBg}` }}>
      {/* HUD */}
      <div style={{ position: "absolute", top: 8, left: 10, zIndex: 2, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", pointerEvents: "none" }}>
        <span style={{ fontSize: 10, color: th.textMuted, fontFamily: "-apple-system, sans-serif", background: `${th.panelBg}cc`, border: `1px solid ${th.border}33`, borderRadius: 6, padding: "3px 8px", backdropFilter: "blur(8px)" }}>
          Graph · {layout.stats.rendered.toLocaleString()} of {layout.stats.total.toLocaleString()} processes
          {layout.stats.hosts > 1 ? ` · ${layout.stats.hosts} hosts` : ""}
          {layout.stats.truncated ? " · truncated" : ""}
        </span>
        <span style={{ fontSize: 9, color: th.textMuted, fontFamily: "-apple-system, sans-serif", pointerEvents: "auto" }}>
          Scroll zoom · drag pan · click select
        </span>
      </div>
      <div style={{ position: "absolute", top: 8, right: 10, zIndex: 2, display: "flex", gap: 4 }}>
        <button type="button" onClick={resetView} style={{ padding: "3px 8px", fontSize: 10, borderRadius: 4, cursor: "pointer", background: th.btnBg, color: th.textDim, border: `1px solid ${th.border}`, fontFamily: "-apple-system, sans-serif" }}>Fit</button>
        <button type="button" onClick={() => setView((v) => ({ ...v, k: Math.min(2.5, v.k * 1.15) }))} style={{ padding: "3px 8px", fontSize: 10, borderRadius: 4, cursor: "pointer", background: th.btnBg, color: th.textDim, border: `1px solid ${th.border}`, fontFamily: "-apple-system, sans-serif" }}>+</button>
        <button type="button" onClick={() => setView((v) => ({ ...v, k: Math.max(0.12, v.k / 1.15) }))} style={{ padding: "3px 8px", fontSize: 10, borderRadius: 4, cursor: "pointer", background: th.btnBg, color: th.textDim, border: `1px solid ${th.border}`, fontFamily: "-apple-system, sans-serif" }}>−</button>
      </div>

      {layout.nodes.length === 0 ? (
        <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: th.textMuted, fontSize: 12, fontFamily: "-apple-system, sans-serif" }}>
          No processes to graph for the current filter. Try Hunt/Raw detections or clear severity filters.
        </div>
      ) : (
        <svg
          width="100%"
          height="100%"
          style={{ cursor: dragRef.current ? "grabbing" : "grab", touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <defs>
            <marker id="pi-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={th.textMuted} />
            </marker>
          </defs>
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {/* Host swimlane labels */}
            {layout.hosts.map((h) => {
              const hostLabel = String(h.host || "");
              const maxHostChars = 22;
              const hostText = hostLabel.length > maxHostChars
                ? `${hostLabel.slice(0, maxHostChars - 1)}…`
                : hostLabel;
              return (
                <g key={h.host}>
                  <text
                    x={12}
                    y={h.y - 8}
                    fill={th.textMuted}
                    fontSize={11}
                    fontFamily="'SF Mono', Menlo, monospace"
                    fontWeight={600}
                  >
                    {hostText}
                  </text>
                  <line
                    x1={8}
                    y1={h.y - 2}
                    x2={8}
                    y2={h.y + h.height + 4}
                    stroke={`${th.border}66`}
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                </g>
              );
            })}

            {/* Edges */}
            {layout.edges.map((e) => {
              const midX = (e.x1 + e.x2) / 2;
              const color = e.level > 0 ? levelColor(e.level) : th.textMuted;
              const conf = e.confidence === "high" ? 0.9 : e.confidence === "medium" ? 0.65 : 0.4;
              return (
                <path
                  key={e.id}
                  d={`M ${e.x1} ${e.y1} C ${midX} ${e.y1}, ${midX} ${e.y2}, ${e.x2} ${e.y2}`}
                  fill="none"
                  stroke={color}
                  strokeOpacity={0.35 + conf * 0.35}
                  strokeWidth={e.level >= 2 ? 2.2 : 1.4}
                  markerEnd="url(#pi-arrow)"
                />
              );
            })}

            {/* Nodes — full labels wrap onto new lines; card height grows to fit */}
            {layout.nodes.map((n, idx) => {
              const isSel = n.key === selectedKey;
              const col = n.level > 0 ? levelColor(n.level) : th.border;
              const fill = isSel ? `${th.accent}22` : n.level > 0 ? `${col}14` : `${th.panelBg}ee`;
              const stroke = isSel ? th.accent : col;
              const padL = 8;
              const padR = n.isSeed && n.level > 0 ? 16 : 8;
              const contentX = padL;
              const contentW = Math.max(36, n.width - padL - padR);
              const titleColor = isSel ? th.accent : th.text;
              const subLine = buildNodeSubLine(n);
              const clipId = `pi-node-clip-${idx}`;
              return (
                <g
                  key={n.key}
                  transform={`translate(${n.x},${n.y})`}
                  style={{ cursor: "pointer" }}
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onSelect?.(n.key);
                  }}
                >
                  <title>{[
                    n.processName,
                    n.pid ? `PID ${n.pid}` : null,
                    n.user || null,
                    n.reason || null,
                    n.image || null,
                    (n.ts || "").slice(0, 19) || null,
                  ].filter(Boolean).join("\n")}</title>
                  <defs>
                    <clipPath id={clipId}>
                      <rect x="0" y="0" width={n.width} height={n.height} rx="8" ry="8" />
                    </clipPath>
                  </defs>
                  <rect
                    width={n.width}
                    height={n.height}
                    rx={8}
                    ry={8}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={isSel ? 2.2 : 1.2}
                    style={{ filter: isSel ? `drop-shadow(0 0 8px ${th.accent}55)` : n.level >= 2 ? `drop-shadow(0 0 4px ${col}33)` : undefined }}
                  />
                  <g clipPath={`url(#${clipId})`}>
                    <rect x={0} y={0} width={4} height={n.height} fill={stroke} opacity={n.level > 0 || isSel ? 1 : 0.35} />
                    <foreignObject
                      x={contentX}
                      y={0}
                      width={contentW}
                      height={n.height}
                      style={{ overflow: "hidden", pointerEvents: "none" }}
                    >
                      <div
                        xmlns="http://www.w3.org/1999/xhtml"
                        style={{
                          width: `${contentW}px`,
                          maxWidth: `${contentW}px`,
                          minHeight: `${n.height}px`,
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "center",
                          gap: 2,
                          boxSizing: "border-box",
                          padding: "6px 2px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: 5,
                            minWidth: 0,
                            maxWidth: "100%",
                          }}
                        >
                          {typeof ptIcon === "function" && (
                            <span style={{ flexShrink: 0, width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>
                              {ptIcon(n.processName)}
                            </span>
                          )}
                          <span
                            style={{
                              flex: "1 1 auto",
                              minWidth: 0,
                              maxWidth: "100%",
                              fontFamily: "'SF Mono', Menlo, monospace",
                              fontSize: 12,
                              fontWeight: 700,
                              color: titleColor,
                              lineHeight: "16px",
                              whiteSpace: "normal",
                              overflowWrap: "anywhere",
                              wordBreak: "break-word",
                            }}
                          >
                            {n.processName}
                          </span>
                        </div>
                        <div
                          style={{
                            maxWidth: "100%",
                            fontFamily: "'SF Mono', Menlo, monospace",
                            fontSize: 9,
                            color: th.textMuted,
                            lineHeight: "12px",
                            paddingLeft: typeof ptIcon === "function" ? 19 : 0,
                            whiteSpace: "normal",
                            overflowWrap: "anywhere",
                            wordBreak: "break-word",
                          }}
                        >
                          {subLine}
                        </div>
                      </div>
                    </foreignObject>
                    {n.isSeed && n.level > 0 && (
                      <circle cx={n.width - 10} cy={10} r={4} fill={col} stroke={th.modalBg} strokeWidth={1} />
                    )}
                  </g>
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}
