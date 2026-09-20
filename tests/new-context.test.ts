import assert from "node:assert/strict";
import test from "node:test";
import { registerNewContext, RESUME_CONTEXT_TYPE } from "../src/new-context.ts";

const harness = () => {
  const handlers = new Map<string, any>();
  const messages: any[] = [];
  const notes: string[] = [];
  const callbacks: any[] = [];
  let tool: any;
  const state = { sessionId: "session-a", idle: false, queued: false };
  const controller = new AbortController();
  const ctx = {
    sessionManager: { getSessionId: () => state.sessionId },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.queued,
    signal: controller.signal,
    compact(options: any) { callbacks.push(options); },
    ui: { notify(text: string) { notes.push(text); } },
  };
  registerNewContext({
    on(name: string, handler: any) { handlers.set(name, handler); },
    registerTool(definition: any) { tool = definition; },
    sendMessage(message: any) { messages.push(message); },
  } as any);
  return {
    state, ctx, controller, callbacks, messages, notes,
    request: (id = "window") => tool.execute(id, {}, controller.signal, undefined, ctx),
    emit: (name: string, event: any = {}) => handlers.get(name)(event, ctx),
    end: () => handlers.get("turn_end")({ toolResults: [{ toolCallId: "window", isError: false }] }, ctx),
  };
};

test("换窗工具只登记请求，工具结果完整后触发且同批请求合并", async () => {
  const h = harness();
  const result = await h.request();
  await h.request("window-2");
  assert.equal(result.details.deferred, true);
  assert.equal(h.callbacks.length, 0);
  h.emit("turn_end", { toolResults: [{ toolCallId: "other", isError: false }] });
  assert.equal(h.callbacks.length, 0);
  h.end(); h.end();
  assert.equal(h.callbacks.length, 1);
  h.state.idle = true;
  h.callbacks[0].onComplete({});
  h.callbacks[0].onComplete({});
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].customType, RESUME_CONTEXT_TYPE);
});

for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown", "session_compact_failed"]) {
  test(`换窗后 ${event} 使旧回调失效`, async () => {
    const h = harness(); await h.request(); h.end();
    h.emit(event);
    h.state.idle = true;
    h.callbacks[0].onComplete({});
    assert.equal(h.messages.length, 0);
  });
}

for (const condition of ["busy", "queued", "session-changed", "user-input", "error"]) {
  test(`换窗回调在 ${condition} 时不擅自续跑`, async () => {
    const h = harness(); await h.request(); h.end();
    h.state.idle = true;
    if (condition === "busy") h.state.idle = false;
    if (condition === "queued") h.state.queued = true;
    if (condition === "session-changed") h.state.sessionId = "session-b";
    if (condition === "user-input") h.emit("input", { source: "interactive" });
    if (condition === "error") h.callbacks[0].onError(new Error("压缩失败"));
    h.callbacks[0].onComplete({});
    assert.equal(h.messages.length, 0);
  });
}

test("已有用户排队输入时保留原回合处理输入，不触发中断式换窗", async () => {
  const h = harness(); await h.request();
  h.state.queued = true; h.end();
  h.state.queued = false; h.end();
  assert.equal(h.callbacks.length, 0);
  assert.equal(h.messages.length, 0);
});

test("用户在工具完成前中止时取消待办换窗", async () => {
  const h = harness(); await h.request();
  h.controller.abort(); h.end();
  assert.equal(h.callbacks.length, 0);
  assert.equal(h.messages.length, 0);
});
