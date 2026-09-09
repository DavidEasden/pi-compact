import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig, scaffoldConfig } from "../src/config.ts";
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
      assert.match(result.compaction.summary, /## Timeline/);
      assert.equal(result.compaction.details.window.sourceHash, result.compaction.details.sourceHash);
      assert.equal(result.compaction.details.window.keptEntryId, "a1");
      assert.equal(result.compaction.details.window.sourceCount, 1);
      assert.match(result.compaction.summary, /windowId:/);
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

test("自动召回只修改当前请求消息，不写入 session，并可避免同一请求重复注入", () => {
  const harness = createHarness();
  try {
    registerHooks(harness.pi as any);
    const entries = [
      messageEntry("old-user", "user", "修复 token 刷新"),
      messageEntry("old-assistant", "assistant", "已定位 src/auth.ts", "old-user"),
      messageEntry("current-user", "user", "请继续 token 刷新", "old-assistant"),
    ];
    let branchAvailable = true;
    const sessionManager = {
      getEntries: () => entries,
      getBranch: () => {
        if (!branchAvailable) throw new Error("branch unavailable");
        return entries;
      },
    };
    const handler = harness.handlers.get("context")![0];
    const ctx = { cwd: harness.cwd, sessionManager };
    const recallOf = (result: any) => result?.messages?.find((message: any) => message.customType === "pi-compact-auto-recall");
    const hintOf = (result: any) => result?.messages?.find((message: any) => message.customType === "pi-compact-memory-hint");
    const first = handler({
      type: "context",
      messages: [{ role: "user", content: "请继续 token 刷新" }],
    }, ctx);
    const firstRecall = recallOf(first);
    const firstHint = hintOf(first);
    assert.equal(first.messages[0].role, "user");
    assert.ok(firstHint);
    assert.equal(firstRecall.customType, "pi-compact-auto-recall");
    assert.match(firstRecall.content, /old-user|old-assistant/);
    assert.equal(entries.length, 3);
    assert.equal(firstRecall.details.chars, firstRecall.content.length);
    assert.equal(firstRecall.details.hitCount, firstRecall.details.entryIds.length);
    assert.equal(firstRecall.details.mode, "full");
    assert.equal(firstRecall.details.sameTurnInjectionCount, 1);
    assert.equal(typeof firstRecall.timestamp, "number");
    assert.equal(firstRecall.content.length <= DEFAULT_CONFIG.autoRecallMaxChars, true);
    assert.equal(firstRecall.details.estimatedTokens, Math.ceil(firstRecall.content.length / 4));
    assert.ok(firstRecall.details.hitCount > 0);
    assert.match(firstHint.content, /pi_memory_search/);

    const repeatedRequest = handler({
      type: "context",
      messages: [{ role: "user", content: "请继续 token 刷新" }],
    }, ctx);
    const repeatedRecall = recallOf(repeatedRequest);
    assert.equal(repeatedRecall.content, firstRecall.content);
    assert.equal(repeatedRecall.details.sameTurnInjectionCount, 2);

    const second = handler({ type: "context", messages: first.messages }, ctx);
    assert.equal(second, undefined);

    entries.push(messageEntry("next-user", "user", "请继续 token 刷新", "current-user"));
    const updated = handler({
      type: "context",
      messages: [{ role: "user", content: "请继续 token 刷新" }],
    }, ctx);
    assert.match(recallOf(updated).content, /current-user/);

    branchAvailable = false;
    const branchFailed = handler({
      type: "context",
      messages: [{ role: "user", content: "请继续 token 刷新" }],
    }, ctx);
    assert.equal(recallOf(branchFailed), undefined);
    assert.ok(hintOf(branchFailed));
  } finally {
    rmSync(harness.cwd, { recursive: true, force: true });
  }
});

test("自动召回 hint 模式只注入短提示，off 模式不注入", () => {
  const hintHarness = createHarness();
  const offHarness = createHarness();
  try {
    writeFileSync(join(hintHarness.cwd, ".pi", "pi-compact.json"), `${JSON.stringify({ ...DEFAULT_CONFIG, autoRecallMode: "hint" })}\n`);
    writeFileSync(join(offHarness.cwd, ".pi", "pi-compact.json"), `${JSON.stringify({ ...DEFAULT_CONFIG, autoRecall: true, autoRecallMode: "off" })}\n`);
    registerHooks(hintHarness.pi as any);
    registerHooks(offHarness.pi as any);
    const entries = [
      messageEntry("old-user", "user", "修复 token 刷新"),
      messageEntry("old-assistant", "assistant", "已定位 src/auth.ts", "old-user"),
      messageEntry("current-user", "user", "请继续 token 刷新", "old-assistant"),
    ];
    const sessionManager = { getEntries: () => entries, getBranch: () => entries };
    const recallOf = (result: any) => result?.messages?.find((message: any) => message.customType === "pi-compact-auto-recall");
    const hint = hintHarness.handlers.get("context")![0]({
      type: "context",
      messages: [{ role: "user", content: "请继续 token 刷新" }],
    }, { cwd: hintHarness.cwd, sessionManager });
    const hintRecall = recallOf(hint);
    assert.equal(hintRecall.customType, "pi-compact-auto-recall");
    assert.equal(hintRecall.details.mode, "hint");
    assert.match(hintRecall.content, /kinds=user/);
    assert.match(hintRecall.content, /short hints/);
    assert.equal(hintRecall.content.includes("已定位 src/auth.ts"), false);
    assert.match(hintRecall.content, /\[old-user\]/);

    const off = offHarness.handlers.get("context")![0]({
      type: "context",
      messages: [{ role: "user", content: "请继续 token 刷新" }],
    }, { cwd: offHarness.cwd, sessionManager });
    assert.equal(recallOf(off), undefined);
    assert.ok(off.messages.some((message: any) => message.customType === "pi-compact-memory-hint"));
  } finally {
    rmSync(hintHarness.cwd, { recursive: true, force: true });
    rmSync(offHarness.cwd, { recursive: true, force: true });
  }
});

test("自动召回默认排除 derived 以及已在上下文中的 entry", () => {
  const harness = createHarness();
  try {
    registerHooks(harness.pi as any);
    const entries = [
      messageEntry("old-user", "user", "修复 token 刷新"),
      { type: "compaction", id: "cp-old", parentId: "old-user", summary: "旧压缩摘要里也有 token 刷新", firstKeptEntryId: "old-assistant" },
      messageEntry("old-assistant", "assistant", "已定位 src/auth.ts", "cp-old"),
      messageEntry("current-user", "user", "请继续 token 刷新", "old-assistant"),
    ];
    const sessionManager = {
      getEntries: () => entries,
      getBranch: () => entries,
      buildContextEntries: () => [entries[2], entries[3]],
    };
    const result = harness.handlers.get("context")![0]({
      type: "context",
      messages: [{ role: "user", content: "请继续 token 刷新" }],
    }, { cwd: harness.cwd, sessionManager });
    const recall = result.messages.find((message: any) => message.customType === "pi-compact-auto-recall");
    assert.match(recall.content, /old-user/);
    assert.equal(recall.content.includes("cp-old"), false);
    assert.equal(recall.content.includes("old-assistant"), false);
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
