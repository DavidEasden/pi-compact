import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig, scaffoldConfig } from "../src/config.ts";
import { readMemoryEvents, readWindowEvents } from "../src/core/store.ts";
import { isSafeCut, registerHooks } from "../src/hooks.ts";
import type { SessionEntryLike } from "../src/types.ts";

type Handler = (event: any, ctx: any) => any;

const createHarness = () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-compact-hooks-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "pi-compact.json"), `${JSON.stringify(DEFAULT_CONFIG)}\n`);
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  return { cwd, handlers, pi };
};

test("配置初始化会递归创建项目级 .pi 配置", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-compact-config-"));
  try {
    scaffoldConfig(cwd);
    assert.deepEqual(loadConfig(cwd), DEFAULT_CONFIG);
    writeFileSync(join(cwd, ".pi", "pi-compact.json"), JSON.stringify({
      summaryMaxChars: 0,
      autoRecall: "yes",
      recallMaxResults: 1000,
      recallMaxChars: 20_000,
      unknownOption: true,
    }));
    assert.deepEqual(loadConfig(cwd), {
      ...DEFAULT_CONFIG,
      recallMaxResults: 30,
      recallMaxChars: 20_000,
    });
    writeFileSync(join(cwd, ".pi", "pi-compact.json"), JSON.stringify({ autoRecall: false }));
    assert.equal(loadConfig(cwd).autoRecall, false);
    assert.equal(loadConfig(cwd).autoRecallMode, "off");
    writeFileSync(join(cwd, ".pi", "pi-compact.json"), JSON.stringify({ autoRecallMode: "hint" }));
    assert.equal(loadConfig(cwd).autoRecallMode, "hint");
    assert.equal(loadConfig(cwd).autoRecall, true);
    writeFileSync(join(cwd, ".pi", "pi-compact.json"), JSON.stringify({ autoRecall: false, autoRecallMode: "full" }));
    assert.equal(loadConfig(cwd).autoRecallMode, "full");
    writeFileSync(join(cwd, ".pi", "pi-compact.json"), JSON.stringify({ autoRecall: true, autoRecallMode: "off" }));
    assert.equal(loadConfig(cwd).autoRecallMode, "off");
    writeFileSync(join(cwd, ".pi", "pi-compact.json"), JSON.stringify({ autoRecallMode: "nope", autoRecall: false }));
    assert.equal(loadConfig(cwd).autoRecallMode, "off");
    writeFileSync(join(cwd, ".pi", "pi-compact.json"), JSON.stringify({ autoRecallMode: "after-compact" }));
    assert.equal(loadConfig(cwd).autoRecallMode, "full");
    scaffoldConfig(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

const messageEntry = (
  id: string,
  role: string,
  content: unknown,
  parentId: string | null = null,
  fields: Record<string, unknown> = {},
): SessionEntryLike => ({
  type: "message",
  id,
  parentId,
  message: { role, content, ...fields },
});

test("session_before_compact 使用 Pi 边界并支持 manual、threshold、overflow", async () => {
  const harness = createHarness();
  try {
    registerHooks(harness.pi as any);
    const branch = [
      messageEntry("u1", "user", "保留 token 刷新细节"),
      messageEntry("a1", "assistant", [{ type: "toolCall", id: "call1", name: "read", arguments: { path: "src/auth.ts" } }], "u1"),
      messageEntry("t1", "toolResult", "token implementation", "a1", { toolCallId: "call1" }),
    ];
    const ctx = { cwd: harness.cwd, ui: { notify() {} } };
    const handler = harness.handlers.get("session_before_compact")![0];
    for (const reason of ["manual", "threshold", "overflow"]) {
      const result = await handler({
        reason,
        branchEntries: branch,
        preparation: {
          firstKeptEntryId: "a1",
          tokensBefore: 100,
          isSplitTurn: false,
          turnPrefixMessages: [],
        },
        signal: new AbortController().signal,
      }, ctx);
      assert.equal(result.compaction.firstKeptEntryId, "a1");
      assert.equal(result.compaction.details.reason, reason);
      assert.deepEqual(result.compaction.details.sourceEntryIds, ["u1"]);
      assert.equal(result.compaction.details.checkpointChars, result.compaction.summary.length);
      assert.equal(result.compaction.details.summaryMaxChars, DEFAULT_CONFIG.summaryMaxChars);
      assert.equal("estimatedTokensAfter" in result.compaction, false);
      assert.equal(result.compaction.details.estimatedTokensAfter, Math.ceil(result.compaction.summary.length / 4));
      assert.equal(result.compaction.details.version, 1);
      assert.equal("usage" in result.compaction, false);
      assert.match(result.compaction.summary, /\"compactor\":\"pi-compact\"/);
      assert.equal(result.compaction.details.window, undefined);
      assert.equal(result.compaction.details.isSplitTurn, false);
      assert.equal(readWindowEvents(harness.cwd).length, 0);
      assert.equal(readMemoryEvents(harness.cwd).length, 0);
      assert.equal(result.compaction.summary.includes("windowId"), false);
    }
    const aborted = await handler({
      reason: "manual",
      branchEntries: branch,
      preparation: { firstKeptEntryId: "a1", tokensBefore: 100, isSplitTurn: false, turnPrefixMessages: [] },
      signal: AbortSignal.abort(),
    }, ctx);
    assert.deepEqual(aborted, { cancel: true });
  } finally {
    rmSync(harness.cwd, { recursive: true, force: true });
  }
});

test("session_before_compact 在边界可能破坏工具链时取消压缩", async () => {
  const harness = createHarness();
  try {
    registerHooks(harness.pi as any);
    const branch = [
      messageEntry("u1", "user", "执行读取"),
      messageEntry("a1", "assistant", [{ type: "toolCall", id: "call1", name: "read", arguments: {} }], "u1"),
      messageEntry("a2", "assistant", "未完成调用后的消息", "a1"),
    ];
    const notifications: string[] = [];
    const handler = harness.handlers.get("session_before_compact")![0];
    const result = await handler({
      reason: "threshold",
      branchEntries: branch,
      preparation: {
        firstKeptEntryId: "a2",
        tokensBefore: 100,
        isSplitTurn: true,
        turnPrefixMessages: [{ role: "user", content: "执行读取" }],
      },
      signal: new AbortController().signal,
    }, { cwd: harness.cwd, ui: { notify(message: string) { notifications.push(message); } } });
    assert.deepEqual(result, { cancel: true });
    assert.equal(notifications.length, 1);
  } finally {
    rmSync(harness.cwd, { recursive: true, force: true });
  }
});

test("preparation 缺失 isSplitTurn 字段时不再误判为矛盾并取消压缩", async () => {
  const harness = createHarness();
  try {
    registerHooks(harness.pi as any);
    const branch = [
      messageEntry("u1", "user", "保留细节"),
      messageEntry("a1", "assistant", [{ type: "toolCall", id: "call1", name: "read", arguments: { path: "src/auth.ts" } }], "u1"),
      messageEntry("t1", "toolResult", "token implementation", "a1", { toolCallId: "call1" }),
    ];
    const notifications: string[] = [];
    const handler = harness.handlers.get("session_before_compact")![0];
    const result = await handler({
      reason: "threshold",
      branchEntries: branch,
      preparation: { firstKeptEntryId: "a1", tokensBefore: 100 },
      signal: new AbortController().signal,
    }, { cwd: harness.cwd, ui: { notify(message: string) { notifications.push(message); } } });
    assert.equal(notifications.length, 0);
    assert.equal(result.compaction.firstKeptEntryId, "a1");
  } finally {
    rmSync(harness.cwd, { recursive: true, force: true });
  }
});

test("Pi 边界不安全时回退到更早的安全边界而不是取消", async () => {
  const harness = createHarness();
  try {
    registerHooks(harness.pi as any);
    // call1 的结果 t1 落在 u2 之后：在 u2 处切开会让 t1 成为孤儿结果；回退到 a1 才安全。
    const branch = [
      messageEntry("u1", "user", "执行读取"),
      messageEntry("a1", "assistant", [{ type: "toolCall", id: "call1", name: "read", arguments: {} }], "u1"),
      messageEntry("u2", "user", "中间插入", "a1"),
      messageEntry("t1", "toolResult", "result", "u2", { toolCallId: "call1" }),
      messageEntry("a2", "assistant", "完成", "t1"),
    ];
    const notifications: string[] = [];
    const handler = harness.handlers.get("session_before_compact")![0];
    const result = await handler({
      reason: "threshold",
      branchEntries: branch,
      preparation: { firstKeptEntryId: "u2", tokensBefore: 100, isSplitTurn: false, turnPrefixMessages: [] },
      signal: new AbortController().signal,
    }, { cwd: harness.cwd, ui: { notify(message: string) { notifications.push(message); } } });
    assert.equal(result.compaction.firstKeptEntryId, "a1");
    assert.deepEqual(result.compaction.details.sourceEntryIds, ["u1"]);
    assert.equal(result.compaction.details.window, undefined);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /回退到更早的安全边界/);
    assert.match(result.compaction.summary, /\"compactor\":\"pi-compact\"/);
  } finally {
    rmSync(harness.cwd, { recursive: true, force: true });
  }
});

test("扩展不注册 context hook，历史和记忆不会自动注入请求", () => {
  const harness = createHarness();
  try {
    registerHooks(harness.pi as any);
    assert.equal(harness.handlers.has("context"), false);
    assert.equal(harness.handlers.has("session_before_compact"), true);
  } finally {
    rmSync(harness.cwd, { recursive: true, force: true });
  }
});

 test("非法 memory/history/window 配置回退到安全默认值", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-compact-config-memory-"));
  try {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "pi-compact.json"), JSON.stringify({
      memory: "yes",
      history: { autoRecallPrimaryOnly: "no", excludeInContext: 1 },
      window: { manifest: "always" },
      memoryHintMaxChars: 0,
    }));
    const config = loadConfig(cwd);
    assert.equal(config.memory.enabled, true);
    assert.equal(config.memory.pinnedInjection, true);
    assert.equal(config.memory.proposalsProvisionalOnly, true);
    assert.equal(config.history.autoRecallPrimaryOnly, true);
    assert.equal(config.history.excludeInContext, true);
    assert.equal(config.window.manifest, true);
    assert.equal(config.memory.hintMaxChars, DEFAULT_CONFIG.memory.hintMaxChars);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
