import { buildProcessVerdictHero, verdictTone } from "../../../utils/process-verdict-hero.js";

/**
 * Verdict-first results banner for Process Inspector.
 * Optional scoped-rebuild controls when the tree was truncated.
 */
export default function ProcessTreeVerdictHero({
  data,
  detMap,
  stories,
  clusters,
  th,
  sevColors,
  ptMitreBadge,
  scoring = false,
  scorePercent = 0,
  onOpenStory,
  // Scoped rebuild (truncation recovery)
  truncated = false,
  rebuildHost = "",
  rebuildFrom = "",
  rebuildTo = "",
  hostOptions = [],
  onRebuildChange,
  onRebuild,
  scoringLabel = "Scoring detections…",
}) {
  const hero = buildProcessVerdictHero({ data, detMap, stories, clusters });
  const tone = verdictTone(hero.verdict, th);
  const tel = hero.telemetry;
  const telChips = [
    tel.processCreate, tel.terminate, tel.processAccess, tel.privilegeUse,
    tel.network, tel.dns, tel.imageLoad, tel.fileCreate,
  ].filter(Boolean);
  const isTruncated = truncated || hero.truncated;

  return (
    <div style={{
      margin: "0",
      padding: "12px 20px 10px",
      borderBottom: `1px solid ${th.border}44`,
      background: scoring
        ? `linear-gradient(135deg, ${th.accent}12 0%, ${th.modalBg}ee 55%)`
        : `linear-gradient(135deg, ${tone}14 0%, ${th.modalBg}ee 55%)`,
      borderLeft: `3px solid ${scoring ? th.accent : tone}`,
      flexShrink: 0,
    }}>
      {scoring && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: th.accent, fontFamily: "-apple-system, sans-serif" }}>
              {scoringLabel} {scorePercent > 0 ? `${scorePercent}%` : ""}
            </span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: `${th.border}44`, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.max(4, scorePercent)}%`, background: th.accent, transition: "width 120ms linear" }} />
          </div>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{
              fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase",
              color: tone, fontFamily: "'SF Mono', Menlo, monospace",
              padding: "2px 8px", borderRadius: 4, background: `${tone}22`, border: `1px solid ${tone}44`,
            }}>{scoring ? "scoring" : hero.verdict}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: th.text, fontFamily: "-apple-system, sans-serif", lineHeight: 1.3 }}>
              {scoring ? "Building detection map…" : hero.verdictText}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11, fontFamily: "'SF Mono', Menlo, monospace", color: th.textDim }}>
            <span>{hero.counts.total.toLocaleString()} processes</span>
            {!scoring && hero.counts.critical > 0 && <span style={{ color: th.sev.critical }}>{hero.counts.critical} critical</span>}
            {!scoring && hero.counts.high > 0 && <span style={{ color: th.sev.high }}>{hero.counts.high} high</span>}
            {!scoring && hero.counts.medium > 0 && <span style={{ color: th.sev.med }}>{hero.counts.medium} medium</span>}
            {!scoring && <span style={{ color: th.textMuted }}>{hero.counts.detected} detected</span>}
            {isTruncated && (
              <span style={{ color: th.danger, fontWeight: 700 }} title="Max process limit reached — raise the limit or rebuild scoped to host/time">
                Truncated
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end", flex: "0 1 auto" }}>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <span title={hero.linkQuality.label} style={{
              fontSize: 9, padding: "2px 7px", borderRadius: 4, fontWeight: 700, fontFamily: "'SF Mono', Menlo, monospace",
              background: hero.linkQuality.mode === "guid" ? `${th.sev.clean}18` : hero.linkQuality.mode === "pid" ? `${th.sev.high}18` : `${th.accent}14`,
              color: hero.linkQuality.mode === "guid" ? th.sev.clean : hero.linkQuality.mode === "pid" ? th.sev.high : th.accent,
              border: `1px solid ${hero.linkQuality.mode === "guid" ? th.sev.clean : hero.linkQuality.mode === "pid" ? th.sev.high : th.accent}33`,
            }}>{hero.linkQuality.label}</span>
            {telChips.map((c) => (
              <span key={c.id} title={`${c.label}: ${c.count.toLocaleString()} matched`} style={{
                fontSize: 9, padding: "2px 6px", borderRadius: 4, fontFamily: "'SF Mono', Menlo, monospace",
                background: c.present ? `${th.sev.clean}14` : `${th.textMuted}10`,
                color: c.present ? th.sev.clean : th.textMuted,
                border: `1px solid ${c.present ? th.sev.clean : th.border}33`,
              }}>{c.id}{c.present ? ` · ${c.count}` : " · —"}</span>
            ))}
          </div>
          {!scoring && hero.techniques.length > 0 && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {hero.techniques.map((t) => (
                <span key={t.tid} style={{ display: "inline-flex" }}>{ptMitreBadge(t.tid)}{t.count > 1 ? <span style={{ fontSize: 8, color: th.textMuted, marginLeft: 2 }}>×{t.count}</span> : null}</span>
              ))}
            </div>
          )}
        </div>
      </div>
      {!scoring && hero.topStories.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {hero.topStories.map((s, i) => {
            const sc = sevColors[s.level] || th.textMuted;
            return (
              <button
                key={s.id || i}
                onClick={() => onOpenStory?.(s)}
                title={s.leadReason || s.title}
                style={{
                  maxWidth: 320, minWidth: 0, padding: "4px 8px", borderRadius: 6, cursor: "pointer",
                  border: `1px solid ${sc}33`, background: `${sc}12`, color: sc,
                  display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10,
                  fontFamily: "-apple-system, sans-serif", fontWeight: 600, textAlign: "left",
                }}
              >
                <span style={{ fontSize: 8, opacity: 0.8, flexShrink: 0 }}>#{i + 1}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>
                {s.hostname && <span style={{ opacity: 0.7, flexShrink: 0, fontFamily: "'SF Mono', Menlo, monospace", fontSize: 8 }}>{s.hostname}</span>}
              </button>
            );
          })}
        </div>
      )}
      {isTruncated && onRebuild && (
        <div style={{
          marginTop: 10, padding: "8px 10px", borderRadius: 8,
          background: `${th.danger}0c`, border: `1px solid ${th.danger}33`,
          display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center",
        }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: th.danger, fontFamily: "-apple-system, sans-serif" }}>
            Max process limit hit — rebuild scoped:
          </span>
          <select
            value={rebuildHost || ""}
            onChange={(e) => onRebuildChange?.({ host: e.target.value })}
            style={{
              fontSize: 10, padding: "3px 6px", borderRadius: 4, maxWidth: 180,
              background: th.bgInput, color: th.text, border: `1px solid ${th.border}`,
              fontFamily: "'SF Mono', Menlo, monospace",
            }}
          >
            <option value="">All hosts</option>
            {hostOptions.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <input
            type="text"
            placeholder="From (YYYY-MM-DD HH:MM:SS)"
            value={rebuildFrom || ""}
            onChange={(e) => onRebuildChange?.({ from: e.target.value })}
            style={{
              fontSize: 10, padding: "3px 6px", borderRadius: 4, width: 160,
              background: th.bgInput, color: th.text, border: `1px solid ${th.border}`,
              fontFamily: "'SF Mono', Menlo, monospace",
            }}
          />
          <input
            type="text"
            placeholder="To (YYYY-MM-DD HH:MM:SS)"
            value={rebuildTo || ""}
            onChange={(e) => onRebuildChange?.({ to: e.target.value })}
            style={{
              fontSize: 10, padding: "3px 6px", borderRadius: 4, width: 160,
              background: th.bgInput, color: th.text, border: `1px solid ${th.border}`,
              fontFamily: "'SF Mono', Menlo, monospace",
            }}
          />
          <button
            type="button"
            onClick={onRebuild}
            style={{
              fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 5, cursor: "pointer",
              background: th.accent, color: "#fff", border: "none", fontFamily: "-apple-system, sans-serif",
            }}
          >
            Rebuild scoped
          </button>
        </div>
      )}
    </div>
  );
}
