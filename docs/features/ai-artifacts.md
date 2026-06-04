---
description: AI Artifacts in IRFlow Timeline - extract local AI assistant history, prompts, tool calls, workspaces, source files, and possible secret exposure into forensic timeline evidence.
---

# AI Artifacts

AI Artifacts turns local AI assistant history into timeline evidence. It helps investigators answer practical incident-response questions: did a user paste credentials into an AI tool, ask for help with suspicious commands, generate code in a sensitive workspace, expose API keys in a prompt, or run an AI assistant during the incident window?

The feature creates an **AI Query History** timeline tab from local desktop, CLI, and editor-assistant stores. Each row keeps the evidence context analysts need: timestamp, role, AI app, invoked action, session, workspace, source file, summary, full text, and endpoint attribution when available.

## Opening AI Artifacts

- **Menu:** **Tools -> Analysis -> AI Artifacts -> Collect AI Artifacts**
- **Single artifact:** **File -> Open...** on a supported AI app folder or file
- **Output:** one **AI Query History** timeline tab

Use the scan workflow for live Mac triage, KAPE collections, mounted disks, copied profile folders, or external triage packages. Use **File -> Open...** when you already know the specific AI artifact root, such as `.claude`, `.codex`, `.cursor`, `.gemini`, or a supported app data directory.

## What It Captures

| Evidence | Why it matters |
|----------|----------------|
| User prompts | Shows user intent, pasted data, searched commands, and questions asked during the incident window. |
| Assistant responses | Preserves generated commands, code, explanations, and possible operational guidance. |
| Invoked tools or actions | Captures shell/editor/model tool calls when the AI app records them locally. |
| Session metadata | Groups prompts and responses into conversations for timeline review. |
| Workspace paths | Connects AI activity to repositories, production directories, mounted evidence, or sensitive project paths. |
| Source files and line hints | Lets analysts trace a row back to the original local artifact. |
| User and host attribution | Helps map AI activity back to an endpoint profile or KAPE collection path. |
| Possible secrets | Review with **Tools -> Detection -> AI Secret Hunt** for exposed keys, private keys, tokens, and credentials. |

## Supported AI Apps

IRFlow scans local artifacts from these AI apps:

| App | Local evidence handled |
|-----|------------------------|
| **Claude Code** | CLI history and project JSONL transcripts under `.claude`. |
| **Claude Desktop** | `claude-code-sessions` metadata linked to Claude Code transcripts when collected. |
| **OpenAI Codex** | `history.jsonl`, rollout JSONL sessions, archived sessions, and session indexes under `.codex`. |
| **ChatGPT Desktop / Atlas** | Local LevelDB and SQLite stores when conversation data exists locally. |
| **Gemini CLI** | Project-scoped chat sessions, checkpoints, and legacy logs under `.gemini`. |
| **Cursor** | Agent transcripts and composer/workspace SQLite chat stores. |
| **GitHub Copilot** | VS Code-family chat sessions and empty-window chat sessions. |
| **Windsurf** | VS Code-family workspace/global chat stores and Cascade inventory. |
| **Continue** | Local session JSON files under `.continue`. |

For exact paths, collection notes, and parser caveats, see [AI Query History and AI App Artifacts](/dfir-tips/ai-query-history).

## Scan Modes

### This Mac

Scans the current analyst profile using the same local paths IRFlow knows how to parse. This is useful for validating the workflow, reviewing your own workstation, or quickly checking whether AI history exists before building a collection profile.

### Browse Folder

Scans a selected folder such as a KAPE collection, copied user profile, mounted disk, or triage package. IRFlow walks common Windows, macOS, and Linux profile layouts and only reads AI roots that resolve inside the selected scope.

This scope confinement matters for incident response: a scan pointed at a collection folder should not silently read unrelated local analyst data.

## AI Secret Hunt

**Tools -> Detection -> AI Secret Hunt** reviews the extracted AI history for possible sensitive data exposure. It is designed for analyst triage, not as a replacement for enterprise secret-scanning controls.

It helps find:

- API keys and service tokens
- PEM private-key blocks
- Cloud access keys
- Credentials and connection strings
- High-confidence provider-specific secret formats

Results are redacted by default. Analysts can reveal evidence when needed, tag findings, open source rows, and export tagged results for reporting.

## Key Columns

| Column | Meaning |
|--------|---------|
| **Timestamp** | Best available event time for the prompt, response, tool call, or metadata row. |
| **Tool** | The AI app family, such as Claude Code, OpenAI Codex, Cursor, or ChatGPT. |
| **InvokedTool** | A tool/action called inside the AI app, such as a shell command or editor operation. Older saved tabs may still show the legacy `ToolName` header. |
| **Role** | User, assistant, tool, system, or metadata role. |
| **Summary** | Grid-friendly preview for scanning large timelines. |
| **FullText** | Complete message body for row detail, search, secret scan, and export. |
| **SessionId** | Conversation or transcript identifier. |
| **Workspace** | Project, cwd, repository, or folder context when available. |
| **SourceFile** | Original artifact path used to produce the row. |
| **AlsoInTools** | Other AI apps where the same prompt appeared after dedupe. |

## Performance and Safeguards

- Large scans run through the background extraction pipeline so the UI stays responsive.
- Folder scans are cancellable.
- Merged AI timelines cap at 3,000,000 rows and report truncation.
- Malformed JSONL lines are skipped and counted in the import notice.
- Subagent or sidechain content can be included for broader hunts, but main-session-only scans are faster for first-pass triage.
- Export packages include the filtered timeline CSV plus a manifest of source files and hashes for the first 250 sources.

## Limitations

- Browser-only AI usage may require browser profile collection; local desktop/CLI history is not the same as cloud account history.
- Newer ChatGPT Desktop encrypted `conversations-v2-*` bundles are inventoried, not decrypted.
- Gemini macOS desktop app history is not parsed; Gemini CLI local sessions are supported.
- Proprietary Windsurf Cascade protobuf bundles are preserved as inventory unless decoders are available.
- Secret detection is intentionally conservative and should be reviewed by an analyst before reporting.

## See Also

- [AI Query History and AI App Artifacts](/dfir-tips/ai-query-history)
- [Supported Formats](/getting-started/supported-formats)
- [KAPE Triage Workflow](/dfir-tips/kape-triage-workflow)
- [Export and Reports](/workflows/export-reports)
