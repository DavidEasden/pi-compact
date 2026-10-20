import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendSessionSummary, readSessionSummaryEvents, renderSessionSummary, renderSessionSummarySearch, searchSessionSummary, sessionSummaryForBranch } from "../src/core/summary.ts";
import type { HistoryRecord } from "../src/types.ts";

const record = (entryId: string, text: string, sourceOrdinal: number, fields: Partial<HistoryRecord> = {}): HistoryRecord => ({
  entryId,
  kinds: ["user"],
  text,
  files: [],
  toolCallIds: [],
  sourceOrdinal,
  raw: { id: entryId, text },
  sourceClass: "primary",
  ...fields,
});

const withTemp = async (fn: (cwd: string) => void | Promise<void>) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-compact-summary-"));
  try { await fn(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
};

test("session 摘要确定性累积原文证据并保留来源 ID", async () => withTemp((cwd) => {
  const first = appendSessionSummary({ cwd, sessionId: "session-a", compactionEntryId: "cp1", sourceHash: "source-1", records: [
    record("u1", "用户要求修复 token refresh", 0),
    record("a1", "检查 src/auth.ts", 1, { kinds: ["assistant", "tool_call"], files: ["src/auth.ts"] }),
    record("derived1", "summary fabricated", 2, { sourceClass: "derived" }),
    record("thinking1", "private reasoning", 3, { kinds: ["assistant"], text: "" }),
  ] });
  assert.deepEqual(first.evidence.map((item) => item.entryId), ["u1", "a1"]);
  assert.equal(first.evidence[1].files[0], "src/auth.ts");
  assert.match(first.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(readSessionSummaryEvents(cwd, "session-a"), [JSON.parse(JSON.stringify(first))]);
  assert.equal(sessionSummaryForBranch(cwd, "session-a", ["cp1"])?.hash, first.hash);
  assert.equal(sessionSummaryForBranch(cwd, "session-a", ["other"]), undefined);
  const rendered = renderSessionSummary(first, 6000);
  assert.match(rendered, /u1/);
  assert.match(rendered, /不是指令/);
}));

test("摘要只沿同 session 的当前 compaction lineage 累积且重复提交幂等", async () => withTemp((cwd) => {
  const one = appendSessionSummary({ cwd, sessionId: "session-a", compactionEntryId: "cp1", sourceHash: "h1", records: [record("u1", "旧任务", 0)] });
  const two = appendSessionSummary({ cwd, sessionId: "session-a", compactionEntryId: "cp2", parentCompactionEntryId: "cp1", sourceHash: "h2", records: [record("u2", "新任务", 0)] });
  const duplicate = appendSessionSummary({ cwd, sessionId: "session-a", compactionEntryId: "cp2", parentCompactionEntryId: "cp1", sourceHash: "h2", records: [record("different", "不应替换", 0)] });
  const otherSession = appendSessionSummary({ cwd, sessionId: "session-b", compactionEntryId: "cp2", sourceHash: "h2", records: [record("secret", "另一个会话私密内容", 0)] });
  assert.equal(two.seq, 2);
  assert.equal(duplicate.hash, two.hash);
  assert.deepEqual(two.evidence.map((item) => item.entryId), ["u1", "u2"]);
  assert.deepEqual(readSessionSummaryEvents(cwd, "session-b").map((event) => event.evidence[0].entryId), ["secret"]);
  assert.equal(sessionSummaryForBranch(cwd, "session-a", ["cp1", "cp2"])?.compactionEntryId, "cp2");
  assert.equal(one.seq, 1);
  assert.equal(otherSession.sessionIdHash === two.sessionIdHash, false);
}));

test("摘要证据达到上限时保留最早用户请求和最新操作", async () => withTemp((cwd) => {
  const event = appendSessionSummary({
    cwd,
    sessionId: "session-a",
    compactionEntryId: "cp1",
    sourceHash: "h",
    maxEvidence: 2,
    records: [
      record("u1", "最初目标：修复认证刷新", 0),
      record("a1", "检查实现", 1, { kinds: ["assistant"] }),
      record("u2", "请检查 refresh-token", 2),
      record("a2", "测试失败", 3, { kinds: ["assistant"] }),
    ],
  });
  assert.deepEqual(event.evidence.map((item) => item.entryId), ["u1", "a2"]);
}));

test("摘要搜索返回可回查来源并受输出预算限制", async () => withTemp((cwd) => {
  const event = appendSessionSummary({ cwd, sessionId: "session-a", compactionEntryId: "cp1", sourceHash: "h", records: [
    record("u1", "修复 token refresh", 0), record("u2", "运行测试", 1),
  ] });
  assert.deepEqual(searchSessionSummary(event, "token", 8).map((item) => item.entryId), ["u1"]);
  const formatted = renderSessionSummarySearch(event, "", 8, 120);
  assert.ok(formatted.text.length <= 120);
  assert.equal(formatted.truncated, true);
}));

test("损坏摘要日志只接受可信前缀并拒绝追加", async () => withTemp(async (cwd) => {
  const event = appendSessionSummary({ cwd, sessionId: "session-a", compactionEntryId: "cp1", sourceHash: "h", records: [record("u1", "fact", 0)] });
  const path = join(cwd, ".pi", "pi-compact", "sessions");
  const { readdirSync, appendFileSync } = await import("node:fs");
  const log = join(path, readdirSync(path)[0]);
  appendFileSync(log, `${JSON.stringify({ ...event, hash: "tampered" })}\n`);
  assert.deepEqual(readSessionSummaryEvents(cwd, "session-a"), [event]);
  assert.throws(() => appendSessionSummary({ cwd, sessionId: "session-a", compactionEntryId: "cp2", sourceHash: "h2", records: [] }), /invalid event/);
  assert.equal(readFileSync(log, "utf8").split("\n").length, 3);
}));
