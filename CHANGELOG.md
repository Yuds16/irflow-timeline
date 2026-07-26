# Changelog

All notable changes to IRFlow Timeline. The macOS release workflow
(`.github/workflows/release-macos.yml`) publishes the section matching the
released version as the GitHub release notes — keep version headers in the form
`## v<MAJOR.MINOR.PATCH>`.

## v1.0.7

Brings **AI assistant query history** into the timeline as a first-class forensic artifact: collect it from a host or triage package, normalize every tool into one tab, and **hunt for secrets that were leaked into AI chats** — passwords, API keys, tokens, and private keys.

### AI Query History (new)

- **Collect AI Artifacts** — choose **This Mac** or **Browse folder** (KAPE / triage / mounted disk); a forensic tree scan finds Windows, Linux, and macOS user-profile layouts, attributes each row to its `Users\<user>` / `home/<user>` profile and host, and merges every source into one **AI Query History** tab with verbose progress. Available from the **Tools** menu and the startup screen.
- **Native, offline extractors — no third-party AI binary:**
  - **Claude Code** — `history.jsonl` + project session JSONL under `.claude/` (Timestamp, Role, Summary, SessionId, Model, token counts, per-user/host attribution). Opening or dropping a `.claude` folder consolidates all JSONL into one tab (fixes JSONL mis-importing as broken CSV columns).
  - **ChatGPT Desktop** — LevelDB conversation metadata + SQLite message tables.
  - **Gemini CLI** — `~/.gemini/tmp/.../chats/session-*.json` (user + model messages, token counts, reasoning flag).
  - **Cursor**, **GitHub Copilot**, **OpenAI Codex**, **Continue**, **Windsurf**, and **Claude Desktop** — chat/session stores decoded into the same unified column schema.
- **Copilot JSONL depth** — replays `kind:0`/`1`/`2`, Code Insiders, and `emptyWindowChatSessions`; flags metadata-only sessions on import.
- **Cursor workspace decode** — project slugs map to filesystem paths where possible; transcript timestamps estimated from file birth/mtime.
- **AI Apps menu** — per-brand-tinted launchers for each supported assistant.

### AI Secret Hunt (new)

- **Automated secret & credential leak detection over collected AI history** — surfaces passwords, API keys, tokens, and private keys that were pasted into AI assistants. Lives under **Detection**, beside Sigma Scan.
- **Two-stage, precision-first detector** — a ReDoS-guarded regex catalog proposes candidates, then a validation layer (format/checksum validators, Shannon entropy, and an allow-list of well-known public test values) confirms them, so the default **Quick** scan favors precision. A **Deep** toggle adds PII (emails, phone numbers, and similar).
- **Redact-by-default** — findings are masked in the UI and **cleartext is never written to disk**; reveal per-row on demand, and each match carries a salted fingerprint for dedup/correlation.
- **Threat-report results view** — a liquid-glass UI on a Unit 42–style palette with progressive disclosure: group findings **by Tool or by Session**, provider badges per finding, and confidence / leak-direction / category chips.
- **Exposure brief** — export a polished **PDF or HTML** report of the findings.

### Under the hood

- New unit coverage across every AI-history extractor (Claude Code, ChatGPT, Gemini, Cursor, Copilot, Codex, Continue, Windsurf, Claude Desktop) and the secret detector, plus the path-attribution and profile-scan helpers.

## v1.0.6

A major release: IRFlow Timeline was rebuilt into ~150 focused modules and gained a full Sigma/Hayabusa detection layer plus RDP bitmap-cache recovery.

### Sigma Detection (new)

- **Dual detection engine** — run Sigma rules over **raw `.evtx` folders** via the bundled **Hayabusa** engine (universal binary, no setup, works offline), or over **imported timelines / EvtxECmd output** via an in-app JS Sigma engine.
- **MITRE ATT&CK-mapped triage dashboard** with severity/status filtering and a reopenable **scan history**.
- Scan **presets**, **custom YAML rules**, and **noisy-rule suppression**.

### RDP Bitmap Cache (new)

- Recover bitmap **tiles and collages** from Windows `bcache*.bmc` / `cache????.bin` artifacts (bundled **bmc-tools**).
- Records source/output hashes, keeps prior extraction history, and exports an **evidence package** for reporting.

### Lateral Movement — Accounts Accuracy

- Privilege/credential counts are now **scoped to lateral-movement activity** instead of host-wide totals, so suspicion scores aren't inflated by background noise.
- **Admin-logon correlation (4624 ↔ 4672)** recovers the ADMIN signal for network logons; machine/service accounts are no longer mislabeled.
- **Per-channel Sources/Targets breakdown** (logon / explicit-cred / RDP) explains why those columns can exceed the logon count.

### Under the Hood

- Full modular refactor of the renderer and main process (~150 focused modules).
- Import, indexing, and Sigma scans now run on **worker threads** for a smoother UI on large (30–50 GB) timelines.

### Build & Security

- **Universal** build (Apple Silicon + Intel), **signed and notarized**.
- Upgraded **xlsx (SheetJS) to 0.20.3**, addressing known vulnerabilities in 0.18.5.

### First-Run Notes

- **Sigma scans work fully offline out of the box.** Both the **EVTX Folder** (Hayabusa) and **Current Timeline Tab / EvtxECmd** (JS engine) scans use rules bundled inside the app — no install or network download is required (important on TLS-intercepting corporate/DFIR networks). When online, you can still refresh the JS Sigma rule set from SigmaHQ via the rule manager.
- **RDP Bitmap Cache** requires **Python 3** installed on your machine.

## v1.0.5

### Bug Fixes

- **Plaso import crash fixed** — all Plaso/log2timeline `.plaso` and `.timeline` files now import correctly (a malformed `LIMIT` clause in the column-discovery query caused a SQLite error on every Plaso file).
- **Intel Mac crash fixed** — `better-sqlite3` is now compiled as a universal fat binary (x86_64 + arm64), so the app no longer crashes on Intel MacBooks when opening a file.

### Context Menu Improvements

- **Filter in / Filter out** — right-click any cell to filter the grid to rows matching that value, or exclude them.
- **Tags submenu** — tags are collapsed into a submenu to keep the context menu compact.
- **Multi-row tagging** — select multiple rows, right-click, and apply a tag to all selected rows at once.
- **Opaque menu background** — grid content no longer bleeds through the context menu.

### Copy Behaviour Fix

- **⌘C respects text selection** — when text is selected in the detail panel, ⌘C copies the selection instead of intercepting it and copying the whole row.
