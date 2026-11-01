import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { resetRuntimeStats, runtimeStats } from "../src/core/runtime-stats.ts";
import { recordsFromEntries } from "../src/core/session.ts";
import { appendMemoryEvent } from "../src/core/store.ts";
import { appendSessionSummary } from "../src/core/summary.ts";
import { buildWindowManifest, persistWindowManifest } from "../src/core/window.ts";
import { registerStatus } from "../src/status.ts";

const tempCwd = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-compact-status-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "pi-compact.json"), `${JSON.stringify(DEFAULT_CONFIG)}\n`);
  return cwd;
};

test("/pi-compact-status 输出日志、注入与压缩统计", async () => {
  const cwd = tempCwd();
  try {
    resetRuntimeStats();
    const records = recordsFromEntries([{ type: "message", id: "u1", message: { role: "user", content: "状态测试" } }]);
    appendMemoryEvent(cwd, {
      type: "create", recordId: "mem_status", author: "user",
      payload: { kind: "fact", content: "状态记忆", scope: "workspace", status: "active", priority: "normal", sourceEntryIds: [], sourceHash: "h" },
    });
    appendMemoryEvent(cwd, {
      type: "create", recordId: "mem_status_2", author: "model",
      payload: { kind: "fact", content: "状态提议", scope: "workspace", status: "provisional", priority: "normal", sourceEntryIds: [], sourceHash: "h2" },
    });
    persistWindowManifest(cwd, buildWindowManifest({
      cwd, records, sourceHash: "hash", keptEntryId: "u1", reason: "manual", isSplitTurn: false,
      sessionId: "status-session", createdAt: "2024-01-01T00:00:00.000Z",
    }));
    appendSessionSummary({ cwd, sessionId: "status-session", compactionEntryId: "cp1", sourceHash: "hash", records });

    runtimeStats.injection = {
      hits: 3, misses: 2, lastChars: 120, lastTokens: 90, lastAt: "2024-01-01T00:00:00.000Z",
    };
    runtimeStats.compact = {
      lastReason: "manual", lastDurationMs: 12, lastRecords: 1, lastCheckpointChars: 80,
      lastDerivedCreated: 1, lastAt: "2024-01-01T00:00:00.000Z",
    };

    const commands = new Map<string, any>();
    const pi = {
      on() {},
      registerTool() {},
      registerCommand(name: string, definition: any) { commands.set(name, definition); },
    };
    registerStatus(pi as any);
    const notes: string[] = [];
    const ctx = {
      cwd,
      ui: { notify(message: string) { notes.push(message); } },
      sessionManager: {
        getSessionId: () => "status-session",
        getBranch: () => [{ type: "compaction", id: "cp1", details: { compactor: "pi-compact" } }],
      },
    };
    await commands.get("pi-compact-status").handler("", ctx);
    const text = notes.at(-1) ?? "";
    assert.match(text, /pi-compact status/);
    assert.match(text, /memory: events=2\/2/);
    assert.match(text, /windows: events=1\/1/);
    assert.match(text, /summary: session=yes events=1 evidence=1/);
    assert.match(text, /injection\(process\): hits=3 misses=2/);
    assert.match(text, /compact\(process\): reason=manual/);
  } finally {
    resetRuntimeStats();
    rmSync(cwd, { recursive: true, force: true });
  }
});
