# pi-compact

> 中文版：[README.zh-CN.md](README.zh-CN.md)

A long-term memory, deterministic session-compaction, and exact-history-recall extension for [Pi](https://pi.dev/).

The core of `pi-compact` is long-term memory. Compaction is only window-capacity management: history remains recoverable, and durable memory must still be reconstructable after many compactions, restarts, and context-window switches, then appear in context automatically. The extension does not call an LLM to generate compaction summaries, and it does not treat compaction checkpoints or model-written notes as a source of truth. Original session entries are never deleted and can be re-read through the recall tool or command.

## Features

- Stores an append-only memory event log under `.pi/pi-compact/`; current memory is rebuilt by a pure projector, and older events cannot silently overwrite newer state.
- Users write authoritative memory with `/remember`, `/memories`, and `/forget`. Model proposals stay provisional and never become active or pinned by themselves.
- Injects a deterministic pinned/active working-memory hint on every context request. Pinned items take priority in the memory budget and cannot be squeezed out by ordinary history recall. A short how-to-query hint is injected even when nothing is pinned.
- Takes over Pi's native `/compact` command and normal `manual`, `threshold`, and `overflow` compactions.
- Reuses Pi's own boundary calculation, token accounting, persistence, and recovery flow. The checkpoint is a deterministic pointer/audit extract, not primary memory.
- Records a WindowManifest (`windowId`, parent window, retained boundary, `sourceCount`, `sourceHash`, `previousHash`).
- Verifies that tool calls and tool results are fully paired before compacting; cancels the takeover on unsafe boundaries to avoid breaking context.
- Produces a deterministic event ledger and does not disguise rule-extracted records as goals, decisions, or completed tasks. Rule-derived facts only extract files, commands, exit codes, and test counts, with provenance.
- History records distinguish `primary` vs `derived`: `compaction` and `branch_summary` stay out of automatic recall by default; thinking remains in `raw` but not in default search text.
- Provides the `pi_compact_recall` tool with list/search/read, entry-ID lookup, keyword search, file-path and kind filters, pagination, and raw-entry replay. Long raw entries support `offset`/`rawLimit`.
- Provides the `/pi-compact-recall` command, which sends recall results to the model as a follow-up turn.
- Provides `pi_memory_search`, `pi_memory_read`, `pi_memory_propose`, `pi_memory_update`, and `pi_compact_new_context`.
- Optionally recalls primary history that is not already in the current request, from the current branch, before every provider request.
- Automatically creates a project-level `.pi/pi-compact.json` config without overwriting existing project or global configs.

## Installation

Pi must already be installed; the verified version is `0.85.1`, which requires Node.js `>=22.19.0`. The instructions below assume this repository lives at `github.com/DavidEasden/pi-compact`.

Pi packages execute extension code, so review the source before installing.

### Install from GitHub

Pin to a release tag (recommended — pinned refs are not moved by `pi update --extensions` or `pi update --all`):

```bash
pi install git:github.com/DavidEasden/pi-compact@v0.1.0
```

Or track the default branch without pinning:

```bash
pi install git:github.com/DavidEasden/pi-compact
```

SSH shorthand and raw HTTPS URLs work too:

```bash
pi install git:git@github.com:DavidEasden/pi-compact@v0.1.0
pi install https://github.com/DavidEasden/pi-compact@v0.1.0
```

Notes:

- The `git:` prefix enables `host/user/repo` and `git@host:user/repo` shorthands; without it, only protocol URLs (`https://`, `http://`, `ssh://`, `git://`) are accepted.
- `v0.1.0` must be an existing tag or commit (create and push it once with `git tag v0.1.0 && git push origin v0.1.0`). To move to a newer tag later, re-run `pi install git:github.com/DavidEasden/pi-compact@<new-tag>`.
- Global installs are cloned to `~/.pi/agent/git/github.com/DavidEasden/pi-compact`; with `-l` (project settings), the clone lives at `.pi/git/github.com/DavidEasden/pi-compact` and the project auto-installs any missing packages on startup after being trusted.
- Try the package without installing it:

```bash
pi -e git:github.com/DavidEasden/pi-compact
```

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

The extension uses Pi's `@earendil-works/pi-coding-agent` API, verified against Pi `0.85.1`. Pi and `typebox` are peer dependencies provided by the Pi environment.

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
| `enabled` | `true` | Enables compaction takeover, working-memory injection, and auto recall; the native `/compact` command, recall tool, and memory commands remain available |
| `overrideDefaultCompaction` | `true` | Whether to take over Pi's normal compaction; when disabled, the default compaction is kept |
| `summaryMaxChars` | `12000` | Maximum character count of the deterministic checkpoint text |
| `autoRecall` | `true` | Compatibility flag. Ignored when `autoRecallMode` is set; if the mode is unset, `false` maps to `off`, otherwise `full` |
| `autoRecallMode` | `full` | Auto-recall mode: `full` (current full snippets), `hint` (short ID/kind lines), or `off` (disabled). A valid mode wins over `autoRecall` |
| `autoRecallMaxChars` | `5000` | Maximum character count of a single auto-history-recall payload; independent from the memory-hint budget |
| `recallMaxResults` | `8` | Maximum number of records returned by auto recall |
| `recallMaxChars` | `16000` | Maximum character count of manual recall output; a single `raw` entry ID is returned as complete JSON even if it exceeds this budget |
| `debug` | `false` | Whether to print extension debug logs (counts and character totals only; never original text) |
| `memory.enabled` | `true` | Enables durable memory reads/writes and working-memory injection |
| `memory.pinnedInjection` | `true` | Inject pinned/active working-memory hints on every context request |
| `memory.proposalsProvisionalOnly` | `true` | Model proposals can only be written as provisional; even `false` does not auto-promote them to active/pinned |
| `memory.hintMaxChars` | `4000` | Maximum character count of the working-memory hint; pinned items take priority |
| `memory.deriveOnCompact` | `true` | Write rule-derived provisional records (files/commands/exit codes/test counts) during compaction |
| `history.autoRecallPrimaryOnly` | `true` | Automatic history recall uses primary records only |
| `history.excludeInContext` | `true` | Exclude entries already present in the current request (`buildContextEntries()`) |
| `window.manifest` | `true` | Write WindowManifest and the window event log during compaction |

Flat aliases such as `memoryEnabled`, `memoryHintMaxChars`, `historyAutoRecallPrimaryOnly`, and `windowManifest` are also accepted; nested objects win. Numeric fields must be positive safe integers. The caps for `summaryMaxChars`, `autoRecallMaxChars`, `recallMaxResults`, `recallMaxChars`, and `memory.hintMaxChars` are `100000`, `50000`, `30`, `100000`, and `50000` respectively; legal values above a cap are clamped, invalid values fall back to defaults, and unknown fields are ignored. Char budgets are not token budgets. Safe defaults: memory on, pinned injection on, model proposals provisional-only, primary-only automatic history recall.

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

Appends to `memory.jsonl` (and `windows.jsonl`) are guarded by a per-log synchronous file lock (`.pi/pi-compact/memory.jsonl.lock`, `windows.jsonl.lock`) so concurrent Pi processes cannot interleave the read-last → compute-seq → append sequence and lose events. The lock has a bounded timeout, recovers locks left behind by crashed processes (unparsable, dead-owner, or expired), is reentrant within a process, and is always released when the transaction ends; lock files never permanently block future writes. Release and reclaim require the lock file's owner token to match, and also the pid/startTime when those fields are present; a metadata mismatch never deletes another owner's lock. On macOS/Linux the lock stores process start time when it can be read, so a reused PID is not treated as the original live owner. If start time cannot be read, the owner is treated as still live until the lock expires — the extension never deletes a lock it cannot prove is stale. Write failures throw explicit errors that surface to the user or model — a write is never reported as successful after a failure.

When reading either log, events must form an unbroken chain: `seq` starts at 1 and increases by exactly one, `prevHash` must equal the previous accepted event's hash, and each event's own hash must be correct. Reading stops at the first invalid, duplicated, skipped, or tampered event and only replays the trusted prefix. Once such an event exists, further appends to that log are rejected with an explicit error: the user must repair the log by hand before writing again, and the extension never truncates or rewrites the log to hide the problem. An unparsable half-line at EOF is still tolerated — it is skipped on read and the next append seals it, so a crash mid-write remains recoverable.

```text
/remember use pnpm instead of npm
/remember pin kind:constraint do not change the production database
/remember supersede:mem_abc the new authoritative statement
/memories
/memories status:pinned token
/forget mem_abc
```

`/remember` accepts `pin`, `kind:`, `scope:`, `priority:`, and `supersede:<id>`. `/memories` can filter by `status:`, `kind:`, and keywords. `/forget` marks a memory as resolved so it leaves working memory. These commands only perform deterministic local writes and UI notifications; they do not trigger a model turn.

Memory tools:

| Tool | Description |
| --- | --- |
| `pi_memory_search` | Search memories; with no query, lists pinned/active/provisional |
| `pi_memory_read` | Read by ID; long content can be sliced with `offset`/`limit` |
| `pi_memory_propose` | Propose a provisional memory; it never becomes active/pinned automatically |
| `pi_memory_update` | Can only edit/resolve the model's own provisional proposals |
| `pi_compact_new_context` | Calls Pi native compact when `ctx.compact` exists; otherwise tells the model to use `/compact` (safe compatibility fallback) |

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

Entry IDs in the examples are placeholders; use the real IDs shown by checkpoints or recall output.

When `ids` is given, records are selected by ID and `scope` and `limit` apply, while the keyword, `file`, `kind`, and `page` are ignored; results are returned in original session order. Without `ids`, a keyword or `file` is required unless `action` is `list` — an empty query or a `kind`-only query does not list the full history.

Keyword search is tokenized text matching; it does not support regular expressions or semantic search. File filtering only matches already-extracted paths and never reads files from disk. Paths mainly come from tool arguments and simple bash commands; paths inside message bodies are not necessarily indexed. The command splits arguments on whitespace and does not parse quoted paths with spaces; pass such paths via the tool's `file` field instead.

The command sends recall content as a follow-up turn, which triggers the model to continue and enters the normal session history.

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

`action` is `list`/`search`/`read`. With `raw: true` and a single entry ID, and without `offset`/`rawLimit`, the output is the complete JSON of that original session entry, including whatever tool arguments, tool output, timestamps, and parent/child entry relationships the entry holds. That single-entry JSON is not sliced, even if it exceeds `recallMaxChars`; if serialization fails, the tool returns a structured error object instead of truncated JSON. With `offset` and `rawLimit`, raw text is read in a character window so long raw is not dumped into context by default. With `raw: true` and multiple hits, only complete entries that fit the character budget are included, followed by an `omitted entry IDs` note; JSON is never cut in the middle. Keyword and pretty (non-raw) output is still limited by `recallMaxChars`. Pagination divides records, not the content of a single entry. For a single raw entry ID, the default result `limit` of 8 is ignored so the requested ID is not dropped. Thinking stays in `raw` but is excluded from default search text. `compaction` and `branch_summary` are derived and stay out of automatic recall by default.

## Auto-recall and working memory

Every context request injects `pi-compact-memory-hint` when memory is enabled and `pinnedInjection` is true. Even with no pinned memories, the hint tells the model how to use `/remember`, `pi_memory_search`, and `pi_compact_recall`. Pinned items take priority in `memory.hintMaxChars` and cannot be squeezed out by ordinary history recall. Working-memory injection and automatic history recall are two separate messages with two budgets.

Auto recall defaults to `full` (the current full-snippet injection) and is gated by `enabled && autoRecallMode !== "off"`. It is high-confidence gated: session-control, politeness, and generic words such as `continue`, `ok`, `thanks`, `请继续`, `好的`, `谢谢`, `上一步`, and `再试一次` do not by themselves inject history body. Manual `pi_compact_recall` is unchanged and still does exact keyword search, including those words. Auto recall does not use query length `>= 3` as the only threshold, and it does not call an LLM, embedding model, or network service.

It triggers only when:

- The latest user text, after deterministic normalization, stopword/stop-phrase filtering, and match-signal grading, still contains a high-confidence term (file path, error code, function name/identifier, command) or a multi-word topic.
- The current session provides a valid active branch.
- The current branch contains a user entry with a valid ID.
- The history before that user entry contains matching records for those high-confidence terms.
- By default only primary records are searched, and entries already present in `buildContextEntries()` are excluded.

Auto recall only modifies the current provider request's messages; it does not write to the session and does not create a session entry. Multiple provider requests in the same user turn reuse the recall result; a new user entry recomputes it. Tool results produced during the current turn are not mixed into that turn's auto-recall scope.

If the branch query fails, no valid user entry exists, or nothing matches, the extension silently skips auto recall. Manual recall does not expand to the whole session when the active lineage is unavailable either; only an explicit `scope:all` searches across branches.

`full` injects clipped snippets of matched records. `hint` injects only compact `- [id] kinds=…` lines (plus extracted file paths when present) without the long snippets. `off` skips injection entirely, including when `autoRecall` is still `true`. Search scope is unchanged: only history before the latest user entry on the current branch; auto recall never widens to other branches.

When `history.excludeInContext` is on and the session provides `buildContextEntries`, auto recall no longer re-injects entries already in the current context. `full` can still increase request token usage. Injected custom messages include cost stats (`chars`, `hitCount`, `estimatedTokens`, `mode`, `sameTurnInjectionCount`) without copying original entry bodies into `details`. Same-turn provider retries reuse the cached recall text and increment `sameTurnInjectionCount`; the working-memory hint counts the same way and is keyed by the current turn's latest user entry id, so the counter resets on a new user turn and only increments on retries within the same turn. If a message of that customType is already in the request, it is not injected again. Recall content is sent to the current model provider and may contain raw tool output or other sensitive text; `raw` does not redact anything, and `scope:all` also includes matching records from other branches. Keeping originals and supporting exact retrieval does not mean the model will obey memories or automatically recall every relevant detail.

## Compaction and data boundaries

`pi-compact` takes over only normal compactions and does not yet take over Pi's `session_before_tree` branch summaries.

During compaction:

1. Uses Pi's `firstKeptEntryId` as the retained boundary.
2. Converts original entries before the boundary into records with IDs.
3. Generates a checkpoint that writes pointer fields such as windowId/parentWindowId/sourceHash/previousHash, then a chronological `## Timeline` (original entry order via `sourceOrdinal`), then the existing groups: user messages, assistant messages, tool calls, tool results, commands, and other session context. Timeline and groups share the same character budget and omitted-line count. The checkpoint is explicitly not primary memory.
4. Stores details such as `sourceEntryIds`, `sourceHash`, `sourceRecordCount`, `keptEntryId`, `omittedRecordCount`, `checkpointChars`, `summaryMaxChars`, `estimatedTokensAfter` (character count / 4, rounded up; not provider usage), and an optional `window` manifest. The extension does not invent billed `usage`; Pi computes its own context-wide post-compaction estimate.
5. Validates the boundary relationships of tool calls and results, and the pairing order in the retained tail; unsafe or already-aborted takeover requests return `{ cancel: true }` and do not fall back to the default LLM summary. On handler errors it degrades to a pointer-style checkpoint instead of letting Pi use an LLM summary. Pi's `error` and `aborted` terminal assistant states allow tool calls without results; this does not apply to ordinary incomplete calls.
6. Window events are appended to `.pi/pi-compact/windows.jsonl` as a previousHash chain, protected by the same per-log file lock and validated with the same trusted-prefix rule on read. The model can request a new window with `pi_compact_new_context`; if the current API has no `ctx.compact`, it tells the user to run `/compact`.

Original session entries remain the source of historical truth; the user-written memory log is the source of durable-memory truth. The checkpoint collapses whitespace, truncates long records, and omits records when the budget runs out; it is not a backup of the raw text and does not verify whether statements in history are correct. Non-text content such as images shows only placeholder information in the text extraction.

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
src/hooks.ts             Compaction, context, working-memory injection, and session hooks
src/recall.ts            Recall tool and /pi-compact-recall command
src/memory.ts            Memory commands and memory/new-window tools
src/core/content.ts      Message text, files, thinking separation, and snippet boundaries
src/core/auto-recall.ts  Deterministic high-confidence gate for automatic history recall
src/core/lock.ts         Synchronous log lock, owner-token reclaim, PID start-time checks
src/core/ledger.ts       Deterministic checkpoint and details
src/core/session.ts      Session entry conversion, sourceClass, search, and raw replay
src/core/jsonl.ts        Corruption-safe JSONL I/O
src/core/projector.ts    Pure-function memory event projection
src/core/store.ts        `.pi/pi-compact/` event logs
src/core/window.ts       WindowManifest and hash chain
src/core/working.ts      Pinned/active working-memory hint
src/core/derive.ts       Non-semantic rule derivation
src/types.ts             Shared types
tests/                   Unit tests
```

## Verification scope

Verified so far:

- Deterministic record extraction, keyword and file search, raw record preservation, and hashing.
- Thinking stays out of default search; derived/compaction stays out of automatic recall by default; in-context entries can be excluded.
- Deterministic memory-event replay, supersede/pin, EOF half-line tolerance plus rejected appends after a chain break, and pinned injection after 100 simulated compactions.
- Working-memory budget priority, window hash chain, memory command/tool entry points, and sliced long-raw reads.
- Compaction boundary checks for tool calls and tool results.
- Config scaffolding and normalization of invalid configs, including memory/history/window.
- `manual`, `threshold`, and `overflow` compaction reasons plus aborted requests, via simulated hook events.
- Empty active lineage does not widen the search; auto-recall same-turn reuse, new-user updates, deduplication, and branch-query error handling.
- Auto-recall high-confidence gating rejects generic continue/ok phrases while still injecting concrete tokens, error codes, and paths; manual recall still matches those generic words.
- Log-lock reclaim refuses token/metadata mismatches; PID reuse vs conservative missing-start-time fallback is unit-tested without real PID recycling.
- Clean dependency installation, TypeScript type checking, and real Pi CLI extension loading.

Not yet verified as full end-to-end scenarios: real model responses, the complete overflow-retry run, and long-running behavior across session or branch switches.

## License

MIT
