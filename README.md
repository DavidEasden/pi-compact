# pi-compact

> 中文版：[README.zh-CN.md](README.zh-CN.md)

A long-term memory, deterministic session-compaction, and exact-history-recall extension for [Pi](https://pi.dev/).

The core of `pi-compact` is long-term memory. Compaction manages window capacity: history remains recoverable, and durable memory can be reconstructed after compactions, restarts, and context-window switches, then queried through tools on demand. The extension does not call an LLM to generate compaction summaries, and it does not treat compaction checkpoints or model-written notes as a source of truth. Original session entries are never deleted and can be re-read through the recall tool or command.

## Features

- Stores an append-only memory event log under `.pi/pi-compact/`; current memory is rebuilt by a pure projector, and older events cannot silently overwrite newer state.
- Users write authoritative memory with `/remember`, `/memories`, and `/forget`. Model proposals stay provisional and never become active or pinned by themselves.
- Models query history and memory through tools on demand. The extension registers no context injection hook and adds no automatic history snippets or pinned/active hints.
- Takes over Pi's native `/compact` command and normal `manual`, `threshold`, and `overflow` compactions.
- Reuses Pi's own boundary calculation, token accounting, persistence, and recovery flow. The checkpoint is a deterministic pointer/audit extract, not primary memory.
- Records a WindowManifest (`windowId`, parent window, retained boundary, `sourceCount`, `sourceHash`, `previousHash`).
- Verifies that tool calls and tool results are fully paired before compacting; on unsafe boundaries it falls back to an earlier safe boundary first and only cancels when no safe boundary exists, to avoid breaking context.
- Produces a deterministic event ledger and does not disguise rule-extracted records as goals, decisions, or completed tasks. Rule-derived facts only extract files, commands, exit codes, and test counts, with provenance.
- History records distinguish `primary` vs `derived`: `compaction` and `branch_summary` are derived and can be filtered with `sourceClass`; thinking remains in `raw` but not in default search text.
- Provides the `pi_compact_recall` tool with list/search/read, entry-ID lookup, keyword search, file-path and kind filters, pagination, and raw-entry replay. Long raw entries support `offset`/`rawLimit`.
- Provides the `/pi-compact-recall` command, which displays results through the UI without triggering a model turn.
- Provides `pi_memory_search`, `pi_memory_read`, `pi_memory_propose`, `pi_memory_update`, and `pi_compact_new_context`.
- Automatically creates a project-level `.pi/pi-compact.json` config without overwriting existing project or global configs.

## Installation

The current source requires Pi `>=0.87.1`; development and integration tests pin `0.87.1`, which requires Node.js `>=22.19.0`. The instructions below assume this repository lives at `github.com/DavidEasden/pi-compact`. The published `v0.3.0` matches the current source.

Pi packages execute extension code, so review the source before installing.

### Install from GitHub

Pin to a release tag (recommended — pinned refs are not moved by `pi update --extensions` or `pi update --all`):

```bash
pi install git:github.com/DavidEasden/pi-compact@v0.3.0
```

Or track the default branch without pinning:

```bash
pi install git:github.com/DavidEasden/pi-compact
```

SSH shorthand and raw HTTPS URLs work too:

```bash
pi install git:git@github.com:DavidEasden/pi-compact@v0.3.0
pi install https://github.com/DavidEasden/pi-compact@v0.3.0
```

Notes:

- The `git:` prefix enables `host/user/repo` and `git@host:user/repo` shorthands; without it, only protocol URLs (`https://`, `http://`, `ssh://`, `git://`) are accepted.
- `v0.3.0` must be an existing tag or commit (create and push it once with `git tag v0.3.0 && git push origin v0.3.0`). To move to a newer tag later, re-run `pi install git:github.com/DavidEasden/pi-compact@<new-tag>`.
- Global installs are cloned to `~/.pi/agent/git/github.com/DavidEasden/pi-compact`; with `-l` (project settings), the clone lives at `.pi/git/github.com/DavidEasden/pi-compact` and the project auto-installs any missing packages on startup after being trusted.
- Try the package without installing it:

```bash
pi -e git:github.com/DavidEasden/pi-compact
```

### Install from npm

The same code is published to npm as `pi-compact`:

```bash
pi install npm:pi-compact@0.3.0
```

Or track the latest published version:

```bash
pi install npm:pi-compact
```

Try it without installing it:

```bash
pi -e npm:pi-compact
```

Notes:

- A versioned spec such as `npm:pi-compact@0.3.0` is pinned, so `pi update --extensions` and `pi update --all` skip it.
- Global installs go under `~/.pi/agent/npm/`; with `-l` (project settings) they go under `.pi/npm/`.

### Try locally

Run from the project root:

```bash
npm ci
pi -e /absolute/path/to/pi-compact
```

You can also point directly at the entry file:

```bash
pi -e /absolute/path/to/pi-compact/index.ts
```

### Install the local package

```bash
pi install /absolute/path/to/pi-compact
```

This writes to the global Pi settings by default. Use `-l` to write to the current project's `.pi/settings.json`:

```bash
pi install -l /absolute/path/to/pi-compact
```

The extension uses Pi's `@earendil-works/pi-coding-agent` API, verified against Pi `0.87.1` for `context_edit` and post-compaction projections. Pi and `typebox` are peer dependencies provided by the Pi environment; the development dependency pins Pi `0.87.1` for reproducible host integration tests.

## Configuration

On first startup, if there is no project config and no global config in the user directory, the extension creates:

```text
.pi/pi-compact.json
```

Config lookup order:

1. Current project `.pi/pi-compact.json`
2. Global `~/.pi/agent/pi-compact.json`
3. Built-in defaults

The extension uses the first existing config file and fills in missing fields with defaults; project and global configs are not merged field-by-field. If the project config exists but cannot be parsed as JSON, the extension falls back to the default config and does not read the global one.

Default config:

```json
{
  "enabled": true,
  "overrideDefaultCompaction": true,
  "summaryMaxChars": 12000,
  "autoRecall": true,
  "autoRecallMode": "full",
  "autoRecallMaxChars": 5000,
  "recallMaxResults": 8,
  "recallMaxChars": 16000,
  "debug": false,
  "memory": {
    "enabled": true,
    "pinnedInjection": true,
    "proposalsProvisionalOnly": true,
    "hintMaxChars": 4000,
    "deriveOnCompact": true
  },
  "history": {
    "autoRecallPrimaryOnly": true,
    "excludeInContext": true
  },
  "window": {
    "manifest": true
  }
}
```

Config fields:

| Field | Default | Description |
| --- | ---: | --- |
| `enabled` | `true` | Enables compaction takeover; recall tools remain available and memory is controlled by `memory.enabled` |
| `overrideDefaultCompaction` | `true` | Whether to take over Pi's normal compaction; when disabled, the default compaction is kept |
| `summaryMaxChars` | `12000` | Maximum character count of the deterministic checkpoint text |
| `autoRecall` | `true` | Legacy compatibility field; does not enable automatic recall |
| `autoRecallMode` | `full` | Parses legacy `full`/`hint`/`off` modes; none inject history at runtime |
| `autoRecallMaxChars` | `5000` | Legacy auto-recall budget; no current runtime effect |
| `recallMaxResults` | `8` | Legacy auto-recall count; no current runtime effect. Manual queries use `limit` |
| `recallMaxChars` | `16000` | Recall output budget, always enforced for model tools. Only the UI command can explicitly request an oversized complete single raw entry |
| `debug` | `false` | Whether to print extension debug logs (counts and character totals only; never original text) |
| `memory.enabled` | `true` | Enables durable memory commands, tool reads/writes, and rule derivation |
| `memory.pinnedInjection` | `true` | Legacy hint-injection flag; no current runtime effect |
| `memory.proposalsProvisionalOnly` | `true` | Model proposals can only be written as provisional; even `false` does not auto-promote them to active/pinned |
| `memory.hintMaxChars` | `4000` | Legacy working-memory hint budget; no current runtime effect |
| `memory.deriveOnCompact` | `true` | Write rule-derived provisional records after successful compaction |
| `history.autoRecallPrimaryOnly` | `true` | Legacy automatic recall source filter; no current runtime effect |
| `history.excludeInContext` | `true` | Legacy automatic recall deduplication flag; no current runtime effect |
| `window.manifest` | `true` | Write WindowManifest and the window event log after successful compaction; cancellation writes neither |

Flat aliases such as `memoryEnabled`, `memoryHintMaxChars`, `historyAutoRecallPrimaryOnly`, and `windowManifest` are also accepted; nested objects win. Numeric fields must be positive safe integers. The caps for `summaryMaxChars`, `autoRecallMaxChars`, `recallMaxResults`, `recallMaxChars`, and `memory.hintMaxChars` are `100000`, `50000`, `30`, `100000`, and `50000` respectively; legal values above a cap are clamped, invalid values fall back to defaults, and unknown fields are ignored. Char budgets are not token budgets. Defaults enable memory and keep model proposals provisional; history and memory are queried on demand. Legacy injection settings are still parsed, but cannot restore the removed context hook.

The automatic compaction threshold and retained-tail size are still controlled by Pi's own compaction settings; this extension does not set its own trigger threshold.

## Usage

### Compact now

Run Pi's native command:

```text
/compact
```

Pi's native `/compact` command calls its normal compaction flow. When `enabled` and `overrideDefaultCompaction` are both `true`, this extension receives the `session_before_compact` event and replaces Pi's default LLM summary with its deterministic checkpoint. The extension does not register a separate compaction command. When `enabled` or `overrideDefaultCompaction` is `false`, `/compact` keeps Pi's default summary behavior.

### Authoritative long-term memory

Durable memory lives in the project directory `.pi/pi-compact/memory.jsonl` (an append-only event log). Current state is rebuilt by a pure projector. User writes are authoritative; model proposals are always provisional and become active/pinned only after the user confirms them with `/remember`. The extension cannot guarantee that the model will obey these memories.

Appends to `memory.jsonl` (and `windows.jsonl`) are guarded by a per-log synchronous file lock (`.pi/pi-compact/memory.jsonl.lock`, `windows.jsonl.lock`) so concurrent Pi processes cannot interleave the read-last → compute-seq → append sequence and lose events. `PI_COMPACT_LOCK_TIMEOUT_MS` is only a bounded wait timeout (mainly for tests), not a live-lock lease: a lock whose owner PID is still alive is never reclaimed because of age. Crash recovery deletes a lock only when the owner PID is known dead, when stored start time and the live process start time are both readable and differ (PID reuse), or when this process can prove from start time that it left the lock behind and does not currently hold it. Linux reads `/proc/<pid>/stat`; macOS and other available Unix platforms try synchronous `ps` with `TZ=UTC`; Windows tries standard OS facilities such as PowerShell `Get-Process` StartTime. Start-time identity is best-effort — not every platform can read it, and any failure is treated as unverified. Unparsable, empty, or otherwise invalid lock metadata is not deleted within a grace period (it may be a concurrent create/write window); after the grace period (`PI_COMPACT_STALE_LOCK_GRACE_MS`, default 1000 ms, mainly for tests) it is reclaimed as a crash leftover so an empty lock file cannot deadlock writes forever. Within the grace period, unverified identity waits until the timeout and throws a clear error that owner metadata could not be verified or the lock is still held, and that the write did not complete. Manual deletion of the `.lock` file remains the explicit recovery path. The lock is reentrant within a process and is always released when the transaction ends. Release and reclaim require the lock file's owner token to match, and also the pid/startTime when those fields are present; missing expected metadata or a mismatch never deletes another owner's lock. Write failures throw explicit errors that surface to the user or model — a write is never reported as successful after a failure.

When reading either log, events must form an unbroken chain: `seq` starts at 1 and increases by exactly one, `prevHash` must equal the previous accepted event's hash, and each event's own hash must be correct. Reading stops at the first invalid, duplicated, skipped, or tampered event and only replays the trusted prefix. Once such an event exists, further appends to that log are rejected with an explicit error: the user must repair the log by hand before writing again, and the extension never truncates or rewrites the log to hide the problem. An unparsable half-line at EOF is still tolerated — it is skipped on read and the next append seals it, so a crash mid-write remains recoverable.

```text
/remember use pnpm instead of npm
/remember pin kind:constraint do not change the production database
/remember supersede:mem_abc the new authoritative statement
/memories
/memories status:pinned token
/forget mem_abc
```

`/remember` accepts `pin`, `kind:`, `scope:`, `priority:`, and `supersede:<id>`. `/memories` can filter by `status:`, `kind:`, and keywords. `/forget` marks a memory as resolved so it leaves default memory queries. These commands only perform deterministic local writes and UI notifications; they do not trigger a model turn.

Memory tools:

| Tool | Description |
| --- | --- |
| `pi_memory_search` | Search memories; with no query, lists pinned/active/provisional |
| `pi_memory_read` | Read by ID; long content can be sliced with `offset`/`limit` |
| `pi_memory_propose` | Propose a provisional memory; it never becomes active/pinned automatically |
| `pi_memory_update` | Can only edit/resolve the model's own provisional proposals |
| `pi_compact_new_context` | Requests compaction after all tools in the batch finish, then resumes the task on success; if unsupported, suggests `/compact` |

Rule-derived memories have `author=rule` and provenance, stay provisional, and are not user-confirmed facts.

### Manual recall

Run inside Pi:

```text
/pi-compact-recall token refresh
```

Supported argument forms:

```text
/pi-compact-recall file:src/auth/session.ts
/pi-compact-recall kind:tool_result timeout
/pi-compact-recall ids:entry-123,entry-456 raw
/pi-compact-recall scope:all old config page:2 limit:5
/pi-compact-recall raw:true file:src/auth.ts
```

Arguments:

| Argument | Description |
| --- | --- |
| Plain text | Searches original session records by keyword |
| `ids:id1,id2` | Selects records exactly by entry ID |
| `file:path` | Matches file paths extracted from records |
| `kind:type` | Filters by `user`, `assistant`, `tool_call`, `tool_result`, `bash`, or `custom` |
| `scope:active-lineage` | Searches only the current branch; the default |
| `scope:all` | Searches the whole session, including other branches |
| `page:N` | Result pagination, starting at 1 |
| `limit:N` | Results per page, default 8, range 1 to 30; not affected by `recallMaxResults` |
| `raw` or `raw:true` | Outputs the raw session entry JSON |
| `list` or `action:list` | Bounded listing of recent records; no keyword required |
| `offset:N` | Character offset for sliced raw reads |
| `rawLimit:N` | Character length for sliced raw reads |
| `sourceClass:primary\\|derived\\|all` | Filter by source class |

Entry IDs in the examples are placeholders; use the real IDs shown by recall output.

When `ids` is given, records are selected by ID and `scope` and `limit` apply, while the keyword, `file`, `kind`, and `page` are ignored; results are returned in original session order. Without `ids`, a keyword or `file` is required unless `action` is `list` — an empty query or a `kind`-only query does not list the full history.

Keyword search is tokenized text matching; it does not support regular expressions or semantic search. File filtering only matches already-extracted paths and never reads files from disk. Paths mainly come from tool arguments and simple bash commands; paths inside message bodies are not necessarily indexed. The command splits arguments on whitespace and does not parse quoted paths with spaces; pass such paths via the tool's `file` field instead.

The command displays recall content through UI notifications without sending it to the model or appending session messages. The UI command supports `scope:all` for other branches; the model tool always stays on the current branch.

### `pi_compact_recall` tool

The model can call it directly:

```json
{
  "query": "token refresh",
  "file": "src/auth/session.ts",
  "kind": "tool_call",
  "scope": "active-lineage",
  "page": 1,
  "limit": 8,
  "raw": false
}
```

Available fields mirror the `/pi-compact-recall` arguments: `query`, `entryIds`, `file`, `kind`, `scope`, `page`, `limit`, `raw`, `action`, `offset`, `rawLimit`, and `sourceClass`.

`action` is `list`/`search`/`read`. All model-tool output, including a single raw entry ID, obeys the `recallMaxChars` hard budget. An oversized single raw entry returns valid JSON containing `entryId`, `offset`, `limit`, `totalChars`, `truncated`, and `body`; use `offset`/`rawLimit` to continue reading. Only the UI command, with one explicit ID and `raw` and no slicing parameters, can return the complete original JSON without that budget.

Multiple raw hits include only complete entries that fit and list omitted IDs; JSON is never cut in the middle. Pretty output is clipped at complete result blocks. Pagination divides records; `offset`/`rawLimit` divides an individual raw entry. Raw data preserves stored tool arguments, outputs, timestamps, and parent links. Thinking stays out of default search text. `compaction` and `branch_summary` are derived and can be filtered with `sourceClass`.

## Query history and memory on demand

The current version registers no `context` hook and injects neither `pi-compact-auto-recall` nor `pi-compact-memory-hint`. Legacy `autoRecall*`, `memory.pinnedInjection`, `memory.hintMaxChars`, and `history.*` fields remain parseable for compatibility but cannot enable injection. Pinned/active memories are available through `pi_memory_search` and `pi_memory_read`.

The model's `pi_compact_recall` searches only the current branch. If the active lineage is unavailable, it does not expand to the whole session. Users can explicitly select `scope:all` in the `/pi-compact-recall` UI command. Tool results enter ordinary model context; UI command results only appear in the interface.

Stored originals remain available for exact retrieval. On-demand queries do not guarantee that the model recalls every relevant detail or follows every memory.

## Compaction and data boundaries

`pi-compact` takes over only normal compactions and does not yet take over Pi's `session_before_tree` branch summaries.

During compaction:

1. Uses Pi's `firstKeptEntryId`, including context-invisible metadata and entries omitted by `context_edit`.
2. Converts the entries before the boundary from Pi's pre-compaction context projection into ID-bearing audit records. `context_edit` omissions affect the checkpoint's source count and hash; replacements affect the projected record content used for derived-memory inputs. The original raw entry remains available for explicit replay.
3. Generates a deterministic checkpoint with only `compactor`, `sourceCount`, and `sourceHash`. It copies no history body and is not primary memory.
4. Stores `sourceEntryIds`, `sourceHash`, `sourceRecordCount`, `keptEntryId`, `omittedRecordCount`, `checkpointChars`, `summaryMaxChars`, `isSplitTurn`, and `estimatedTokensAfter` (character count / 4, rounded up; not provider usage). Pi computes its own context-wide post-compaction estimate; the extension does not invent billed usage.
5. Previews each candidate compaction with Pi 0.87.1's `buildSessionProjection()`, checking the retained tail after omissions and replacements. Results must follow their calls, and ordinary calls must have results; the replaced prefix does not block compaction. Unsafe boundaries fall back only to earlier candidates in the current compaction window, after previewing each candidate. No safe boundary, failed projection, or an aborted request cancels compaction without falling back to LLM summarization. Pi's `error`/`aborted` assistant states may have calls without results. Once validation passes, checkpoint generation errors degrade to pointer JSON; a changed boundary gets a recomputed `isSplitTurn`.
6. Only after Pi commits compaction and emits success does the extension generate and append a window manifest under the log lock. Window IDs bind the session and actual compaction entry, so repeated events do not append duplicates. Rule-derived memories are also written after success. Cancellation and failure leave no window or derived records. Legacy `details.window` remains readable; new manifests live in `.pi/pi-compact/windows.jsonl`.

Original session entries remain the source of historical truth; the user-written memory log is the source of durable-memory truth. The checkpoint stores only counts and a hash; it is not a backup of raw text and does not verify whether statements in history are correct. Non-text content such as images shows only placeholder information in the text extraction.

The extension does not delete original session entries and does not create a separate backup; the raw text still relies on Pi's session storage. A finite context cannot display all history at once.

## Development

Install dependencies:

```bash
npm ci
```

Run tests:

```bash
npm test
```

`npm test` runs unit and Pi SDK integration tests; `npm run test:integration` runs only the host lifecycle tests. Integration tests use a local Faux provider without API keys or online model requests, and write sessions and logs only to temporary directories.

Run the TypeScript type check:

```bash
npm run typecheck
```

Inspect published contents:

```bash
npm pack --dry-run
```

The published allowlist is `index.ts` and `src/`; npm also automatically includes `package.json` and README files. Test files and `tsconfig.json` are not part of the package.

## Project structure

```text
index.ts                 Pi extension entry
src/config.ts            Config loading, normalization, and scaffolding
src/hooks.ts             Compaction projection validation and session hooks
src/recall.ts            Recall tool and /pi-compact-recall command
src/memory.ts            Memory commands and memory/new-window tools
src/core/content.ts      Message text, files, thinking separation, and snippet boundaries
src/core/auto-recall.ts  Legacy gate pure functions, not connected at runtime
src/core/lock.ts         Synchronous log lock, owner-token reclaim, portable start-time identity
src/core/ledger.ts       Deterministic checkpoint and details
src/core/session.ts      Session entry conversion, sourceClass, search, and raw replay
src/core/jsonl.ts        Corruption-safe JSONL I/O
src/core/projector.ts    Pure-function memory event projection
src/core/store.ts        `.pi/pi-compact/` event logs
src/core/window.ts       WindowManifest and hash chain
src/core/working.ts      Legacy hint pure functions, not connected at runtime
src/core/derive.ts       Non-semantic rule derivation
src/types.ts             Shared types
tests/                   Unit tests
```

## Verification scope

Verified so far:

- Deterministic record extraction, keyword and file search, raw record preservation, and hashing.
- Thinking stays out of default search; primary/derived filtering and current-branch enforcement for the model tool.
- Deterministic memory-event replay, supersede/pin, EOF half-line tolerance, and rejected appends after a chain break.
- Window hash chain, memory command/tool entry points, and sliced long-raw reads.
- Compaction boundary checks for tool calls and tool results.
- Config scaffolding and normalization of invalid configs, including memory/history/window.
- `manual`, `threshold`, and `overflow` compaction reasons plus aborted requests, via simulated hook events.
- Empty active lineage does not widen the search; no context hook is registered, so history and working memory are not injected automatically.
- Legacy auto-recall gates and working-memory renderers retain unit tests; these do not imply runtime injection.
- Log locks refuse token/metadata mismatches and do not reclaim live owners by age. Invalid metadata can be reclaimed after the grace period. Portable start-time identity (Linux `/proc`, Unix `ps`, Windows `Get-Process`) and conservative unverified fallback are unit-tested without changing `process.platform` or recycling real PIDs.
- Clean dependency installation, TypeScript type checking, and real Pi CLI extension loading.

- Pi 0.87.1 SDK metadata boundaries, full overflow retry, `context_edit` omissions/replacements and candidate projections, cancellation of orphan tool results, parallel/sequential tool-batch continuation, user abort, cancellation without side effects, success-event deduplication, and session persistence/restoration.
- Memory-tool disablement, session isolation, explicit historical status queries, long-content/JSON budgets, and search/read pagination.

Online model API responses and billing, manual TUI interactions, and long-running behavior remain outside these tests.

## License

MIT
