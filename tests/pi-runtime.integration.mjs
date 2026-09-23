import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createHarness, assistant, toolCall, user, usage, estimateTokens, SessionManager, untilEvent } from "./helpers/pi-session.mjs";

const rows = (cwd, name) => {
  const path = join(cwd, ".pi", "pi-compact", `${name}.jsonl`);
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
};

for (const metadata of ["usage", "model_change", "custom"]) {
  test(`Pi SDK：${metadata} 边界按默认预算丢弃旧的大回复`, async () => {
    const h = await createHarness({ compaction: { keepRecentTokens: 20000 } });
    try {
      h.sm.appendMessage(user("早期目标"));
      h.sm.appendMessage(assistant("旧".repeat(400000)));
      if (metadata === "usage") h.sm.appendUsage("cache_warm", "pi-compact-test", "local", usage(0));
      if (metadata === "model_change") h.sm.appendModelChange("pi-compact-test", "local");
      if (metadata === "custom") h.sm.appendCustomEntry("test-metadata", {});
      const boundary = h.sm.getLeafId();
      h.sm.appendMessage(user("新".repeat(60000)));
      h.sm.appendMessage(assistant("答".repeat(40000)));
      h.sync();
      const result = await h.session.compact();
      assert.equal(h.preparations[0].firstKeptEntryId, boundary);
      assert.equal(result.firstKeptEntryId, boundary);
      assert.ok(h.session.messages.reduce((n, message) => n + estimateTokens(message), 0) < 26000);
      assert.equal(JSON.stringify(h.session.messages).includes("旧".repeat(100)), false);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

test("Pi SDK：元数据边界的 overflow retry 实际恢复", async () => {
  const h = await createHarness({ contextWindow: 1000, compaction: { enabled: true, keepRecentTokens: 50 } });
  try {
    h.sm.appendMessage(user("早期目标"));
    h.sm.appendMessage({ ...assistant("HISTORY".repeat(6000)), usage: usage(10) });
    h.sm.appendUsage("cache_warm", "pi-compact-test", "local", usage(0));
    h.sm.appendMessage(user("NEW".repeat(40)));
    h.sm.appendMessage({ ...assistant("DONE".repeat(40)), usage: usage(10) });
    h.sync();
    const sizes = [];
    const response = (ctx) => {
      const size = ctx.messages.reduce((n, message) => n + estimateTokens(message), 0);
      sizes.push(size);
      return size > 1000 ? assistant("", { stopReason: "error", errorMessage: "prompt is too long" }) : assistant("恢复成功");
    };
    h.queue(response, response);
    await h.session.prompt("继续任务");
    assert.equal(sizes.length, 2);
    assert.ok(sizes[0] > 1000 && sizes[1] < 1000);
    assert.equal(h.session.getLastAssistantText(), "恢复成功");
    const omissions = h.sm.getEntries().filter((entry) => entry.type === "context_edit" && entry.replacement === null);
    assert.ok(omissions.length > 0);
    assert.ok(omissions.every((edit) => h.sm.buildSessionProjection().entries
      .every((entry) => entry.sourceEntry.id !== edit.targetId || entry.messages.length === 0)));
    assert.deepEqual(h.session.messages, h.sm.buildSessionContext().messages);
    assert.ok(h.events.some((event) => event.type === "compaction_end" && event.reason === "overflow" && event.willRetry));
  } finally { h.close(); }
});

test("Pi 0.87.1：被省略的 toolResult 切点原样提交，恢复后无孤立工具调用", async () => {
  const h = await createHarness({ persistent: true });
  try {
    h.sm.appendMessage(user("执行读取"));
    h.sm.appendMessage(assistant(toolCall("read", { path: "src/a.ts" }, "call-1"), { stopReason: "toolUse" }));
    const resultId = h.sm.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "读取完成" }], isError: false, timestamp: Date.now() });
    const attemptId = h.sm.appendMessage(assistant("", { stopReason: "error", errorMessage: "prompt is too long" }));
    h.sm.appendContextEdit(attemptId, null);
    h.sm.appendContextEdit(resultId, null);
    const rawResult = h.sm.getEntry(resultId);
    h.sync();
    const result = await h.session.compact();
    assert.equal(h.preparations[0].firstKeptEntryId, resultId);
    assert.equal(result.firstKeptEntryId, resultId);
    assert.equal(h.notifications.some((text) => text.includes("回退到更早")), false);
    assert.equal(h.session.messages.some((message) => message.role === "toolResult" || message.role === "assistant"), false);
    assert.deepEqual(h.sm.getEntry(resultId), rawResult);
    assert.equal(rows(h.cwd, "windows")[0].keptEntryId, resultId);
    h.queue(assistant("继续完成任务"));
    await h.session.prompt("继续任务");
    assert.equal(h.session.getLastAssistantText(), "继续完成任务");
    const restored = SessionManager.open(h.sm.getSessionFile());
    assert.deepEqual(restored.buildSessionContext().messages, h.session.messages);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const replacement of [null, { content: "撤回工具调用" }]) {
  test(`Pi 0.87.1：${replacement === null ? "省略" : "替换"}调用后拒绝保留孤立结果，取消无写入`, async () => {
    const h = await createHarness();
    try {
      h.sm.appendMessage(user("旧任务"));
      h.sm.appendMessage(assistant("旧任务已完成"));
      h.sm.appendMessage(user("新的任务"));
      const callId = h.sm.appendMessage(assistant(toolCall("read", {}, "orphan-1"), { stopReason: "toolUse" }));
      h.sm.appendMessage({ role: "toolResult", toolCallId: "orphan-1", toolName: "read", content: [{ type: "text", text: "失去调用的结果" }], isError: false, timestamp: Date.now() });
      h.sm.appendContextEdit(callId, replacement);
      h.sync();
      await assert.rejects(h.session.compact(), /Compaction cancelled/);
      assert.equal(h.compactions().length, 0);
      assert.equal(rows(h.cwd, "windows").length, 0);
      assert.equal(rows(h.cwd, "memory").length, 0);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

for (const mode of ["parallel", "sequential"]) {
  test(`Pi SDK：${mode} 同批工具完成落盘后只换窗一次并续跑`, { timeout: 10000 }, async () => {
    let completed = false, snapshotResults = [];
    const h = await createHarness({
      toolExecution: mode,
      observe: (pi) => pi.on("session_before_compact", (_event, ctx) => {
        snapshotResults = ctx.sessionManager.getBranch().filter((entry) => entry.message?.role === "toolResult");
        assert.equal(completed, true);
      }),
      customTools: [{
        name: "sibling_work", label: "本地探针", description: "验证同批工具完成", parameters: { type: "object", properties: {} },
        async execute(_id, _input, signal) {
          signal.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, 20));
          signal.throwIfAborted();
          completed = true;
          return { content: [{ type: "text", text: "兄弟工作已完成" }], details: {} };
        },
      }],
    });
    try {
      h.queue(assistant([
        toolCall("pi_compact_new_context", {}, "window-1"),
        toolCall("sibling_work", {}, "sibling"),
        toolCall("pi_compact_new_context", {}, "window-2"),
      ], { stopReason: "toolUse" }), assistant("续跑完成"));
      const resumed = untilEvent(h, (event) => event.type === "agent_settled" && h.session.getLastAssistantText() === "续跑完成");
      await Promise.all([h.session.prompt("完成工作后换窗继续"), resumed]);
      assert.equal(snapshotResults.length, 3);
      assert.ok(snapshotResults.every((entry) => !entry.message.isError));
      assert.equal(h.compactions().length, 1);
      assert.equal(h.sm.getEntries().filter((entry) => entry.customType === "pi-compact-resume").length, 1);
      assert.equal(h.faux.getPendingResponseCount(), 0);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

test("Pi SDK：换窗被取消时无窗口日志、派生记忆或自动续跑", async () => {
  const h = await createHarness({ after: (pi) => pi.on("session_before_compact", () => ({ cancel: true })) });
  try {
    h.sm.appendMessage({ role: "bashExecution", command: "npm test", output: "12 passed, 0 failed", exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now() });
    h.sm.appendMessage(user("请检查 src/example.ts")); h.sm.appendMessage(assistant("准备")); h.sync();
    h.queue(assistant(toolCall("pi_compact_new_context", {}), { stopReason: "toolUse" }), assistant("不应执行"));
    const cancelled = untilEvent(h, (event) => event.type === "compaction_end");
    const [, end] = await Promise.all([h.session.prompt("换窗"), cancelled]);
    assert.equal(end.aborted, true);
    assert.equal(h.compactions().length, 0);
    assert.equal(rows(h.cwd, "windows").length, 0);
    assert.equal(rows(h.cwd, "memory").length, 0);
    assert.equal(h.faux.getPendingResponseCount(), 1);
    assert.equal(h.sm.getEntries().some((entry) => entry.customType === "pi-compact-resume"), false);
  } finally { h.close(); }
});

test("Pi SDK：用户中止工具批次后不触发换窗或续跑", async () => {
  let h;
  h = await createHarness({
    toolExecution: "sequential",
    customTools: [{
      name: "cancel_run", label: "中止探针", description: "模拟用户中止", parameters: { type: "object", properties: {} },
      async execute() {
        // 不等待 abort；它需要等当前工具返回才能完成。
        void h.session.abort();
        return { content: [{ type: "text", text: "用户已中止" }], details: {} };
      },
    }],
  });
  try {
    h.queue(assistant([toolCall("pi_compact_new_context", {}), toolCall("cancel_run", {})], { stopReason: "toolUse" }), assistant("不应继续"));
    await h.session.prompt("执行工作");
    assert.equal(h.events.some((event) => event.type === "compaction_start"), false);
    assert.equal(h.faux.getPendingResponseCount(), 1);
  } finally { h.close(); }
});

test("Pi SDK：成功后提交窗口，重复事件去重，摘要相同也绑定实际新窗口", async () => {
  let emitSaved, savedEvent;
  const h = await createHarness({
    persistent: true, config: { summaryMaxChars: 2 },
    after: (pi) => pi.on("session_compact", (event, ctx) => { savedEvent = event; emitSaved = ctx; }),
  });
  try {
    h.sm.appendMessage({ role: "bashExecution", command: "npm test", output: "12 passed, 0 failed", exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now() });
    h.sync();
    h.queue(assistant("回复")); await h.session.prompt("检查 src/example.ts");
    await h.session.compact();
    h.sm.appendMessage(user("第二次请求")); h.sm.appendMessage(assistant("第二次回复")); h.sync();
    await h.session.compact();
    const windows = rows(h.cwd, "windows");
    assert.equal(windows.length, 2);
    assert.notEqual(windows[0].windowId, windows[1].windowId);
    assert.equal(windows[1].parentWindowId, windows[0].windowId);
    assert.equal(windows[1].previousHash, windows[0].hash);
    assert.ok(rows(h.cwd, "memory").length > 0);
    // 重放同一成功事件，验证事件去重不依赖内存中的一次性标记。
    await h.session._extensionRunner.emit(savedEvent);
    assert.equal(rows(h.cwd, "windows").length, 2);
    const restored = SessionManager.open(h.sm.getSessionFile());
    assert.deepEqual(restored.buildSessionContext().messages, h.session.messages);
    assert.deepEqual(h.errors, []);
    assert.ok(emitSaved);
  } finally { h.close(); }
});

test("Pi SDK：真实工具包装执行记忆隔离、预算、状态查询与禁用检查", async () => {
  const a = await createHarness();
  const call = (h, name, args) => h.tool(name).execute("test", args, new AbortController().signal);
  let b;
  try {
    const local = await call(a, "pi_memory_propose", { content: "会话私有", scope: "session" });
    const shared = await call(a, "pi_memory_propose", { content: "内容".repeat(100000) });
    b = await createHarness({ cwd: a.cwd });
    const hidden = await call(b, "pi_memory_read", { recordId: local.details.recordId });
    assert.equal(hidden.details.count, 0);
    const update = await call(b, "pi_memory_update", { recordId: local.details.recordId, action: "resolve" });
    assert.equal(update.details.count, 0);
    const large = await call(b, "pi_memory_read", { recordId: shared.details.recordId });
    assert.ok(large.content[0].text.length <= 16000);
    assert.equal(JSON.parse(large.content[0].text).nextOffset, 4000);
    await call(a, "pi_memory_update", { recordId: local.details.recordId, action: "resolve" });
    const resolved = await call(a, "pi_memory_search", { status: "resolved" });
    assert.equal(resolved.details.count, 1);
    writeFileSync(join(a.cwd, ".pi", "pi-compact.json"), JSON.stringify({ memory: { enabled: false } }));
    const before = rows(a.cwd, "memory").length;
    for (const name of ["pi_memory_read", "pi_memory_update"]) {
      const result = await call(a, name, { recordId: shared.details.recordId, ...(name.endsWith("update") ? { action: "resolve" } : {}) });
      assert.match(result.content[0].text, /记忆功能已关闭/);
    }
    assert.equal(rows(a.cwd, "memory").length, before);
  } finally { b?.close(); a.close(); }
});
