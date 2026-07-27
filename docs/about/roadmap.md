---
description: IRFlow Timeline roadmap — planned features, upcoming enhancements, and how to contribute via GitHub.
---

# Roadmap

This page outlines the planned direction for IRFlow Timeline. Priorities may shift based on community feedback and real-world investigation needs. Have a feature request? [Open an issue](https://github.com/r3nzsec/irflow-timeline/issues) on GitHub.

---

## In Progress

### Process Inspector depth (next release)
- Verdict hero, Story / Graph / Raw modes, **Rules** health coverage report, Filter Grid pivots, and Lateral/Persistence/Sigma handoffs — see [Process Inspector](/features/process-tree) and the [changelog Unreleased](/about/changelog) section
- Further rule-catalog expansion and analyst-facing coverage tooling

### Open Triage Collection & multi-source analyzers
- Folder-level KAPE/triage inventory with LM and Sigma lanes
- Persistence multi-source + **Analyze KAPE Collection**; Lateral Movement multi-source budget and detector registry hardening

### Enhanced Detection Rules
- Expand the detection rules library beyond the current ones
- Community-contributed rule packs with shared rule repositories

---

## Planned

### Cross-Platform Support
- **Windows** and **Linux** builds to make IRFlow Timeline available beyond macOS
- Platform-specific packaging (MSI/EXE for Windows, AppImage/deb for Linux)

### Timeline Diffing
- Compare two timelines or sessions side by side
- Highlight events present in one timeline but not the other
- Useful for comparing baseline vs. compromised host activity

### Collaborative Sessions
- Share `.tle` session files with annotations via a link
- Real-time collaborative analysis for team-based investigations

### AI-Assisted Analysis (LLM — planned)
- **Not the same as v1.0.7 AI Artifacts** — local AI history collection and **AI Secret Hunt** already ship today; see [AI Artifacts](/features/ai-artifacts) and [AI Query History](/dfir-tips/ai-query-history)
- LLM-powered summarization of tagged findings for report drafting
- Natural language queries against timeline data ("show me all lateral movement after 3 AM")
- Anomaly detection suggestions based on statistical patterns

---

## Under Consideration

### Plugin System
- Extensible architecture for community-developed analysis modules
- Custom parsers for proprietary log formats

### Cloud Evidence Formats
- Native parsing of Azure AD sign-in logs, AWS CloudTrail, GCP audit logs
- Unified authentication timeline across on-prem and cloud environments

---

## Recently Completed

See the [Changelog](/about/changelog) for detailed release notes on everything shipped so far. Highlights from recent releases:

- **Process Inspector investigation UX (unreleased / in tree)** — multi-pass enrichment, async scoring, Story/Graph views, rule health report, Filter Grid, cross-analyzer handoffs
- **AI Artifacts (v1.0.7)** — **Collect AI Artifacts** merges local assistant stores (Claude, Codex, ChatGPT Desktop, Gemini CLI, Cursor, Copilot, Windsurf, Continue) into one **AI Query History** tab from this Mac or KAPE/triage folders; **AI Secret Hunt** finds exposed keys, tokens, and credentials with redacted-by-default triage and exportable exposure briefs
- **Sigma Detection** — Dual JS Sigma + Hayabusa engine scanning raw EVTX, EvtxECmd output, and imported timelines, with custom rule collections, MITRE ATT&CK mapping, a triage dashboard, noisy-rule suppression, and persistent scan history
- **RDP Bitmap Cache** — ANSSI-FR `bmc-tools` integration to recover bitmap tiles from `bcache*.bmc` / `cache????.bin` artifacts with an exportable, hashed evidence package
- **Lateral Movement expansion** — Accounts and Exec Sessions tabs, pair-based Incidents, multi-hop Campaign clustering, and a Telemetry Coverage panel
- **Auto-Update** — In-app update notifications with download progress, one-click install, and automatic startup checks
- **NTFS Analysis Tools** — Raw `$MFT` and `$J` (USN Journal) import with six analysis tools: Ransomware Analysis (with PDF export), Timestomping Detection, File Activity Heatmap, ADS Analyzer, USN Journal Analysis with [UsnJrnl Rewind](https://cybercx.com.au/blog/ntfs-usnjrnl-rewind/) path reconstruction (11 categories), and Resident Data Extraction for recovering deleted threat actor artifacts
- **VirusTotal Integration** — API key configuration, single and bulk IOC lookups, persistent SQLite cache with configurable TTL, rate limiting, color-coded verdict badges, and auto-tagging
- **Analyst Profiles** — Suppressions and baselines for Process Inspector false-positive management with save/load persistence
- **v1.0.5** — Cell context menu (Cmd+Click filter in/out), multi-row tagging, Tags hover submenu, Plaso import fix, `.timeline` format support, V8 heap limit for main process
- **v1.0.4** — Stacking 3→1 query, CSV O(n²)→O(n) parsing, Plaso single-pass sampling, sample-based empty column detection, MFT buffer overflow protection, VT retry cancellation
- **v1.0.3** — Lateral Movement attack pattern detection, RDP session grouping, menu bar redesign, row checkbox selection, Find Duplicates, Persistence Analyzer custom rules
- **v1.0.2** — 342 detection rules library, import queue system, IOC matching expansion (17+ types), Process Tree overhaul, Lateral Movement expansion with RDP correlation
- **v1.0.0** — Persistence Analyzer (EVTX + registry persistence detection), lateral movement outlier detection, background indexing pipeline, phase-tuned SQLite performance
