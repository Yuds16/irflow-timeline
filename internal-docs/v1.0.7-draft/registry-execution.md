---
description: Raw Windows registry hive parsing (SYSTEM/SOFTWARE/NTUSER/Amcache) plus execution-evidence decoders — Amcache, ShimCache (AppCompatCache), UserAssist, a cross-artifact Program Execution view, and Prefetch.
---

# Registry & Execution Artifacts

> **Draft for v1.0.7** — not linked from the public docs site until release.

IRFlow Timeline parses **raw Windows registry hives** and the **program-execution artifacts** that live inside them directly — no RECmd / AmcacheParser / PECmd pre-processing required. Drop a triage collection's hives in and the timeline (and the Persistence Analyzer) light up immediately.

## Supported formats

| Artifact | How it arrives | What you get |
|----------|----------------|--------------|
| **Registry hives** (`SYSTEM`, `SOFTWARE`, `SAM`, `SECURITY`, `NTUSER.DAT`, `UsrClass.dat`, `.hve`) | Drag-drop / Open | One row per key/value, keyed on each key's **LastWrite** time |
| **Amcache.hve** | Drag-drop / Open | Execution view: path, **SHA1**, publisher, link date, size, first-seen |
| **ShimCache** (AppCompatCache) | Decoded from a loaded `SYSTEM` hive | Executable path + file last-modified time, in cache order |
| **UserAssist** | Decoded from a loaded `NTUSER.DAT` | GUI-launched programs: run count, last-execution time |
| **Prefetch** (`.pf`) | Drag-drop / Open | Executable, run count, last-run time(s) — *Win7/8 today (see below)* |

Hives are read fully into memory (they're small and random-access by design), but rows still stream into SQLite, so the grid stays windowed on large hives.

## Persistence Analyzer lights up automatically

Raw registry rows are emitted with a `KeyPath` shaped like `\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` (the synthetic hive root is replaced with the logical hive name). That is exactly the contract the [Persistence Analyzer](/features/persistence-analyzer)'s registry mode auto-detects — so importing a `SOFTWARE`/`SYSTEM`/`NTUSER` hive and running **Tools → Platforms → Windows → Persistence Analyzer** fires all **33 registry key-family rules** (Run keys, Services, IFEO, Winlogon, AppInit, COM hijacks, Defender tampering, …) with no extra steps.

## Execution artifacts

Find these under **Tools → Platforms → Windows**:

- **Program Execution** — correlates every loaded Amcache, `SYSTEM` (ShimCache), and `NTUSER` (UserAssist) hive into a single *what-ran* table, one row per program, sorted so binaries that multiple artifacts agree on (`CorrobCount` / `Sources`) rise to the top. It opens as a normal grid tab, so sorting, filtering, tagging, and **VirusTotal enrichment on the `SHA1` column** all work directly.
- **Decode ShimCache (SYSTEM)** — turns the active `SYSTEM` hive into a standalone ShimCache tab.
- **Decode UserAssist (NTUSER)** — turns the active `NTUSER.DAT` into a standalone UserAssist tab.

::: tip Amcache → VirusTotal
Amcache records carry SHA1 hashes. Open the Amcache (or Program Execution) tab, then run a [VirusTotal](/features/virustotal) bulk lookup on the `SHA1` column to get execution evidence and reputation in one pass.
:::

## ShimCache timestamp caveat

The time on a ShimCache (AppCompatCache) entry is the executable's **`$STANDARD_INFORMATION` last-modified time at the moment it was cached — not an execution time.** Presence in the cache (and its order) is evidence the binary existed and was likely run; treat the timestamp as a file-modification artifact, and corroborate execution with Amcache / UserAssist / Prefetch / 4688.

## Prefetch status

Uncompressed Prefetch (**Windows 7 / 8**, SCCA versions 23/26) decodes today: executable, run count, and last-run time(s).

**Windows 10 / 11 Prefetch is MAM/LZXPRESS-Huffman compressed.** Rather than ship an unverified decompressor (which could emit wrong forensic data), IRFlow **recognizes** a compressed `.pf` and reports it clearly instead of guessing. Win10/11 decompression is a tracked follow-up that will be validated against real samples before it ships. (For now, decode Win10/11 Prefetch with PECmd and import the CSV.)

## Dirty hives

If a hive's primary/secondary sequence numbers disagree, its transaction logs (`.LOG1`/`.LOG2`) were not replayed — some keys/values may be stale. IRFlow imports it best-effort and raises a **"Dirty registry hive"** warning so you don't trust a partial view. Replay the logs (RegRipper, `yarp`, or a live registry) for a complete picture.
