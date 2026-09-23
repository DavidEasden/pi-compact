import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findEarlierSafeCut, isSafeCut } from "../src/hooks.ts";
import type { SessionEntryLike } from "../src/types.ts";

const callContent = [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } }];
const createSession = () => SessionManager.inMemory("/tmp/pi-compact-projection-test");
const append = (session: SessionManager, message: unknown) => session.appendMessage(message as any);
const branchOf = (session: SessionManager) => session.getBranch() as unknown as SessionEntryLike[];
const seedPair = (session: SessionManager) => {
  append(session, { role: "user", content: "检查文件" });
  const call = append(session, { role: "assistant", content: callContent, stopReason: "toolUse" });
  const result = append(session, { role: "toolResult", toolCallId: "call-1", content: "读取完成" });
  return { call, result };
};

test("context_edit 省略的 toolResult 可以作为切点，不能回退保留孤立调用", () => {
  const session = createSession();
  const { call, result } = seedPair(session);
  const failed = append(session, { role: "assistant", content: "", stopReason: "error" });
  session.appendContextEdit(failed, null);
  session.appendContextEdit(result, null);
  const branch = branchOf(session);
  const original = JSON.stringify(branch);
  assert.equal(isSafeCut(branch, result), true);
  assert.equal(findEarlierSafeCut(branch, result), result);
  assert.equal(isSafeCut(branch, call), false);
  assert.equal(JSON.stringify(branch), original);
  assert.equal(session.getEntries().some((entry) => entry.type === "compaction"), false);
});

test("省略或替换 assistant 的工具调用后，不能放行仍可见的孤立结果", () => {
  for (const replacement of [null, { content: "工具调用已撤回" }]) {
    const session = createSession();
    const { call } = seedPair(session);
    session.appendContextEdit(call, replacement);
    assert.equal(isSafeCut(branchOf(session), call), false);
    assert.equal(findEarlierSafeCut(branchOf(session), call), undefined);
    // 最后一次编辑生效；恢复完整内容后重新形成合法配对。
    session.appendContextEdit(call, { content: callContent as any });
    assert.equal(isSafeCut(branchOf(session), call), true);
  }
});

test("失败 attempt 与工具结果同时省略时，不受 raw 中的缺失或错误配对阻塞", () => {
  const session = createSession();
  append(session, { role: "user", content: "重试任务" });
  const attempt = append(session, { role: "assistant", content: callContent, stopReason: "length" });
  session.appendContextEdit(attempt, null);
  assert.equal(isSafeCut(branchOf(session), attempt), true);
  const result = append(session, { role: "toolResult", toolCallId: "call-1", content: "失败结果" });
  session.appendContextEdit(result, null);
  assert.equal(isSafeCut(branchOf(session), attempt), true);
  assert.equal(isSafeCut(branchOf(session), result), true);
});

test("回退早于上次 compaction 时，重新出现的原始工具链仍须校验", () => {
  const session = createSession();
  const { call, result } = seedPair(session);
  session.appendContextEdit(result, null);
  const kept = append(session, { role: "user", content: "新的任务" });
  session.appendCompaction("旧 checkpoint", kept, 100);
  append(session, { role: "assistant", content: "新的回复", stopReason: "stop" });
  assert.equal(isSafeCut(branchOf(session), kept), true);
  // 当前投影没有 call；回退却会重新保留它和 omission edit，产生未完成调用。
  assert.equal(isSafeCut(branchOf(session), call), false);
});

test("上次 compaction 已丢弃的编辑，只在候选回退重新保留它时生效", () => {
  const session = createSession();
  const { call, result } = seedPair(session);
  session.appendContextEdit(call, { content: "撤回调用" });
  const kept = append(session, { role: "user", content: "后续任务" });
  session.appendCompaction("旧 checkpoint", kept, 100);
  append(session, { role: "assistant", content: "回复", stopReason: "stop" });
  assert.equal(isSafeCut(branchOf(session), kept), true);
  assert.equal(isSafeCut(branchOf(session), call), false);
  assert.equal(isSafeCut(branchOf(session), result), false);
});

test("回退不会越过当前 compaction window 重新引入已压缩的工具调用", () => {
  const session = createSession();
  const { result } = seedPair(session);
  session.appendCompaction("不完整的旧边界", result, 100);
  append(session, { role: "assistant", content: "后续回复", stopReason: "stop" });
  assert.equal(isSafeCut(branchOf(session), result), false);
  assert.equal(findEarlierSafeCut(branchOf(session), result), undefined);
});

test("无法投影的分支取消安全边界查询，不抛出异常回落默认摘要", () => {
  const branch: SessionEntryLike[] = [
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "请求" } },
    { type: "message", id: "broken", parentId: "u" },
  ];
  assert.equal(isSafeCut(branch, "broken"), false);
  assert.equal(findEarlierSafeCut(branch, "broken"), undefined);
});

test("保留投影仍拒绝结果先于调用、重复结果、缺失 ID 和普通未完成调用", () => {
  const result = { role: "toolResult", toolCallId: "call-1", content: "结果" };
  const call = { role: "assistant", content: callContent, stopReason: "toolUse" };
  for (const messages of [
    [result, call],
    [call, result, result],
    [call],
    [call, { role: "toolResult", content: "缺失 ID" }],
    [{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] }],
  ]) {
    const session = createSession();
    append(session, { role: "user", content: "旧任务" });
    const kept = append(session, { role: "user", content: "保留任务" });
    for (const message of messages) append(session, message);
    assert.equal(isSafeCut(branchOf(session), kept), false);
  }
});
