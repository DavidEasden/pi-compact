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
    const first = handler({
      type: "context",
      messages: [{ role: "user", content: "请继续 token 刷新" }],
    }, ctx);
    assert.equal(first.messages.length, 2);
    assert.equal(first.messages[1].customType, "pi-compact-auto-recall");
    assert.match(first.messages[1].content, /old-user|old-assistant/);
    assert.equal(entries.length, 3);

    const repeatedRequest = handler({
      type: "context",
      messages: [{ role: "user", content: "请继续 token 刷新" }],
    }, ctx);
    assert.equal(repeatedRequest.messages.length, 2);
    assert.equal(repeatedRequest.messages[1].content, first.messages[1].content);

    const second = handler({ type: "context", messages: first.messages }, ctx);
    assert.equal(second, undefined);

    entries.push(messageEntry("next-user", "user", "请继续 token 刷新", "current-user"));
    const updated = handler({
      type: "context",
      messages: [{ role: "user", content: "请继续 token 刷新" }],
    }, ctx);
    assert.match(updated.messages[1].content, /current-user/);

    branchAvailable = false;
    assert.equal(handler({
      type: "context",
      messages: [{ role: "user", content: "请继续 token 刷新" }],
    }, ctx), undefined);
  } finally {
    rmSync(harness.cwd, { recursive: true, force: true });
  }
});
