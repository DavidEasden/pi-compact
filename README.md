# pi-compact

> 中文版：[README.zh-CN.md](README.zh-CN.md)

A deterministic session-compaction and exact-history-recall extension for [Pi](https://pi.dev/).

`pi-compact` does not call an LLM to generate compaction summaries. Instead, it extracts traceable context records from Pi's original session entries and preserves entry IDs, file paths, tool-call IDs, raw records, and source hashes. History that did not fit into the checkpoint text can be re-read through the recall tool or command.

## Features

- Takes over Pi's normal `manual`, `threshold`, and `overflow` compactions.
- Reuses Pi's own boundary calculation, token accounting, persistence, and recovery flow.
- Verifies that tool calls and tool results are fully paired before compacting; cancels the takeover on unsafe boundaries to avoid breaking context.
- Produces a deterministic event ledger and does not disguise rule-extracted records as goals, decisions, or completed tasks.
- Extracts and searches user messages, assistant messages, tool calls, tool results, bash commands, and other session context.
- Provides the `pi_compact_recall` tool with entry-ID lookup, keyword search, file-path and kind filters, pagination, and raw-entry replay.
- Provides the `/pi-compact-recall` command, which sends recall results to the model as a follow-up turn.
- Optionally recalls old records from the current branch before every provider request, based on the current user request.
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
  "debug": false
}
```

Config fields:

| Field | Default | Description |
| --- | ---: | --- |
| `enabled` | `true` | Enables compaction takeover and auto recall; does not unregister the manual commands or recall tool |
| `overrideDefaultCompaction` | `true` | Whether to take over Pi's normal compaction; when disabled, the default compaction is kept |
| `summaryMaxChars` | `12000` | Maximum character count of the deterministic checkpoint text |
| `autoRecall` | `true` | Compatibility flag. Ignored when `autoRecallMode` is set; if the mode is unset, `false` maps to `off`, otherwise `full` |
| `autoRecallMode` | `full` | Auto-recall mode: `full` (current full snippets), `hint` (short ID/kind lines), or `off` (disabled). A valid mode wins over `autoRecall` |
| `autoRecallMaxChars` | `5000` | Maximum character count of a single auto-recall payload |
| `recallMaxResults` | `8` | Maximum number of records returned by auto recall |
| `recallMaxChars` | `16000` | Maximum character count of manual recall output; a single `raw` entry ID is returned as complete JSON even if it exceeds this budget |
| `debug` | `false` | Whether to print extension debug logs (counts and character totals only; never original text) |

Numeric fields must be positive safe integers. The caps for `summaryMaxChars`, `autoRecallMaxChars`, `recallMaxResults`, and `recallMaxChars` are `100000`, `50000`, `30`, and `100000` respectively; legal values above a cap are clamped, invalid values fall back to defaults, and unknown fields are ignored. Char budgets are not token budgets.

The automatic compaction threshold and retained-tail size are still controlled by Pi's own compaction settings; this extension does not set its own trigger threshold.

## Usage

### Compact now

Run inside Pi:

```text
/pi-compact
```

This command uses Pi's existing `ctx.compact()` flow. The extension notifies the Pi UI when compaction completes or fails. When `enabled` or `overrideDefaultCompaction` is `false`, the command still triggers Pi's compaction flow, but this extension no longer replaces the default summary.

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

Entry IDs in the examples are placeholders; use the real IDs shown by checkpoints or recall output.

When `ids` is given, records are selected by ID and `scope` and `limit` apply, while the keyword, `file`, `kind`, and `page` are ignored; results are returned in original session order. Without `ids`, a keyword or `file` is required — an empty query or a `kind`-only query does not list the full history.

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

Available fields mirror the `/pi-compact-recall` arguments: `query`, `entryIds`, `file`, `kind`, `scope`, `page`, `limit`, and `raw`.

With `raw: true` and a single entry ID, the output is the complete JSON of that original session entry, including whatever tool arguments, tool output, timestamps, and parent/child entry relationships the entry holds. That single-entry JSON is not sliced, even if it exceeds `recallMaxChars`; if serialization fails, the tool returns a structured error object instead of truncated JSON. With `raw: true` and multiple hits, only complete entries that fit the character budget are included, followed by an `omitted entry IDs` note; JSON is never cut in the middle. Keyword and pretty (non-raw) output is still limited by `recallMaxChars`. Pagination divides records, not the content of a single entry. For a single raw entry ID, the default result `limit` of 8 is ignored so the requested ID is not dropped.

## Auto-recall behavior

Auto recall defaults to `full` (the current full-snippet injection) and is gated by `enabled && autoRecallMode !== "off"`. It triggers only when:

- The latest user text of the current request, trimmed, is at least 3 characters long.
- The current session provides a valid active branch.
- The current branch contains a user entry with a valid ID.
- The history before that user entry contains matching records.

Auto recall only modifies the current provider request's messages; it does not write to the session and does not create a session entry. Multiple provider requests in the same user turn reuse the recall result; a new user entry recomputes it. Tool results produced during the current turn are not mixed into that turn's auto-recall scope.

If the branch query fails, no valid user entry exists, or nothing matches, the extension silently skips auto recall. Manual recall does not expand to the whole session when the active lineage is unavailable either; only an explicit `scope:all` searches across branches.

`full` injects clipped snippets of matched records. `hint` injects only compact `- [id] kinds=…` lines (plus extracted file paths when present) without the long snippets. `off` skips injection entirely, including when `autoRecall` is still `true`. Search scope is unchanged: only history before the latest user entry on the current branch; auto recall never widens to other branches.

Auto recall does not require a prior compaction, so `full` may duplicate history already present in context and adds to request token usage. Injected custom messages include cost stats (`chars`, `hitCount`, `estimatedTokens`, `mode`, `sameTurnInjectionCount`) without copying original entry bodies into `details`. Same-turn provider retries reuse the cached recall text and increment `sameTurnInjectionCount`; if an auto-recall message is already in the request, it is not injected again. Recall content is sent to the current model provider and may contain raw tool output or other sensitive text; `raw` does not redact anything, and `scope:all` also includes matching records from other branches.

## Compaction and data boundaries

`pi-compact` takes over only normal compactions and does not yet take over Pi's `session_before_tree` branch summaries.

During compaction:

1. Uses Pi's `firstKeptEntryId` as the retained boundary.
2. Converts original entries before the boundary into records with IDs.
3. Generates a checkpoint that starts with a chronological `## Timeline` (original entry order via `sourceOrdinal`), then keeps the existing groups: user messages, assistant messages, tool calls, tool results, commands, and other session context. Timeline and groups share the same character budget and omitted-line count.
4. Stores details such as `sourceEntryIds`, `sourceHash`, `sourceRecordCount`, `keptEntryId`, `omittedRecordCount`, `checkpointChars`, `summaryMaxChars`, and `estimatedTokensAfter` (character count / 4, rounded up; not provider usage). The compaction result also sets `estimatedTokensAfter` and does not invent billed `usage`.
5. Validates the boundary relationships of tool calls and results, and the pairing order in the retained tail; unsafe or already-aborted takeover requests return `{ cancel: true }` and do not fall back to the default LLM summary. Pi's `error` and `aborted` terminal assistant states allow tool calls without results; this does not apply to ordinary incomplete calls.

Original session entries remain the source of truth. The checkpoint collapses whitespace, truncates long records, and omits records when the budget runs out; it is not a backup of the raw text and does not verify whether statements in history are correct. Non-text content such as images shows only placeholder information in the text extraction.

The extension does not delete original session entries and does not create a separate backup; the raw text still relies on Pi's session storage. Keeping the originals and supporting exact retrieval does not mean the model will automatically recall every relevant detail, nor that a finite context can display all history at once.

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
src/command.ts           /pi-compact command
src/hooks.ts             Compaction, context, and session hooks
src/recall.ts            Recall tool and /pi-compact-recall command
src/core/content.ts      Message text, file, and tool-call extraction
src/core/ledger.ts       Deterministic checkpoint and details
src/core/session.ts      Session entry conversion, search, and raw replay
src/types.ts             Shared types
tests/                   Unit tests
```

## Verification scope

Verified so far:

- Deterministic record extraction, keyword and file search, raw record preservation, and hashing.
- Compaction boundary checks for tool calls and tool results.
- Config scaffolding and normalization of invalid configs.
- `manual`, `threshold`, and `overflow` compaction reasons plus aborted requests, via simulated hook events.
- Empty active lineage does not widen the search; auto-recall same-turn reuse, new-user updates, deduplication, and branch-query error handling.
- Clean dependency installation, TypeScript type checking, and real Pi CLI extension loading.

Not yet verified as full end-to-end scenarios: real model responses, the complete overflow-retry run, and long-running behavior across session or branch switches.

## License

MIT
