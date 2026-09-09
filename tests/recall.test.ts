import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { formatHits, formatRecallOutput, parseCommand, registerRecall } from "../src/recall.ts";
import { recordsFromEntries } from "../src/core/session.ts";
import type { SessionEntryLike } from "../src/types.ts";

const entries: SessionEntryLike[] = [
  { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T00:00:00Z", message: { role: "user", content: "修复 src/auth/session.ts 的 token 刷新问题" } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "我会先检查 session 实现" }, { type: "toolCall", id: "call1", name: "read", arguments: { path: "src/auth/session.ts" } }] } },
];

const toHits = (source: SessionEntryLike[]) => recordsFromEntries(source).map((record) => ({ ...record, score: 1, snippet: record.text }));

const includedRawEntries = (text: string): unknown[] => {
  const chunks = text.split(/\n(?=\[entry )/);
  const parsed: unknown[] = [];
  for (const chunk of chunks) {
    const start = chunk.indexOf("\n{");
    if (start < 0) continue;
    const note = chunk.indexOf("\n\n(omitted");
    parsed.push(JSON.parse(note >= 0 ? chunk.slice(start + 1, note) : chunk.slice(start + 1)));
  }
  return parsed;
};

test("parseCommand 识别 ids 与 raw", () => {
  assert.deepEqual(parseCommand("ids:entry-123,entry-456 raw"), {
    entryIds: ["entry-123", "entry-456"],
    raw: true,
    query: "",
  });
  assert.equal(parseCommand("raw:true file:src/auth.ts").raw, true);
  assert.equal(parseCommand("token refresh").query, "token refresh");
  assert.equal(parseCommand("list offset:10 rawLimit:20").action, "list");
  assert.equal(parseCommand("list offset:10 rawLimit:20").offset, 10);
  assert.equal(parseCommand("list offset:10 rawLimit:20").rawLimit, 20);
});

test("formatHits 单条 raw 返回可解析的完整 entry JSON", () => {
  const [hit] = toHits([entries[0]]);
  const text = formatHits([hit], true, 16000, true);
  assert.deepEqual(JSON.parse(text), hit.raw);
});

test("formatHits 单条 raw 即使超过预算也不截断 JSON", () => {
  const raw: SessionEntryLike = {
    type: "message",
    id: "big",
    parentId: null,
    message: { role: "user", content: "x".repeat(20_000) },
  };
  const [hit] = toHits([raw]);
  const text = formatHits([hit], true, 16000, true);
  assert.ok(text.length > 16000);
  const parsed = JSON.parse(text);
  assert.equal(parsed.id, "big");
  assert.equal(parsed.message.content.length, 20_000);
  assert.equal(formatRecallOutput([hit], true, 16000, true).truncated, false);
});

test("formatHits 多条 raw 只返回预算内的完整 JSON 并提示剩余 ID", () => {
  const tiny: SessionEntryLike[] = [
    { type: "message", id: "a", message: { role: "user", content: "aa" } },
    { type: "message", id: "b", message: { role: "user", content: "bb" } },
  ];
  const hits = toHits(tiny);
  const header = "pi-compact recall (2 result(s))\n\n";
  const firstBody = `[entry a]\n${JSON.stringify(hits[0].raw, null, 2)}`;
  const note = "\n\n(omitted entry IDs: b; use a single entry ID to retrieve full JSON)";
  const formatted = formatRecallOutput(hits, true, header.length + firstBody.length + note.length);
  assert.equal(formatted.truncated, true);
  assert.match(formatted.text, /omitted entry IDs: b/);
  const included = includedRawEntries(formatted.text);
  assert.equal(included.length, 1);
  assert.deepEqual(included[0], hits[0].raw);
  const both = formatRecallOutput(hits, true, 100000);
  assert.equal(both.truncated, false);
  assert.equal(includedRawEntries(both.text).length, 2);
});

test("formatHits 多条 raw 在首条已超出预算时不截断 JSON", () => {
  const hits = toHits([
    { type: "message", id: "big1", message: { role: "user", content: "y".repeat(5000) } },
    { type: "message", id: "big2", message: { role: "user", content: "z".repeat(5000) } },
  ]);
  const formatted = formatRecallOutput(hits, true, 400);
  assert.equal(formatted.truncated, true);
  assert.match(formatted.text, /0 included/);
  assert.match(formatted.text, /omitted entry IDs: big1, big2/);
  assert.equal(includedRawEntries(formatted.text).length, 0);
  assert.equal(formatted.text.includes("yyyy"), false);
});

test("formatHits 单条 raw 序列化失败时返回结构化错误", () => {
  const [hit] = toHits([entries[0]]);
  const circular: Record<string, unknown> = { id: "u1" };
  circular.self = circular;
  const text = formatHits([{ ...hit, raw: circular }], true, 16000, true);
  const parsed = JSON.parse(text);
  assert.equal(parsed.error, "pi-compact recall: failed to serialize entry");
  assert.equal(parsed.entryId, "u1");
  assert.equal(formatRecallOutput([{ ...hit, raw: circular }], true, 16000, true).truncated, true);
});

test("关键词召回仍按字符预算截断，保持兼容", () => {
  const hits = toHits(entries);
  const formatted = formatRecallOutput(hits, false, 80);
  assert.match(formatted.text, /pi-compact recall/);
  assert.ok(formatted.text.length <= 80);
  assert.equal(formatted.truncated, true);
  assert.equal(formatHits(hits, false, 80), formatted.text);
  assert.equal(formatted.text.includes("[entry"), false);
});

test("非 entry ID 的单条 raw 命中仍遵守字符预算", () => {
  const raw: SessionEntryLike = {
    type: "message",
    id: "keyword-big",
    message: { role: "user", content: "q".repeat(20_000) },
  };
  const [hit] = toHits([raw]);
  const formatted = formatRecallOutput([hit], true, 400, false);
  assert.ok(formatted.text.length <= 400);
  assert.equal(formatted.truncated, true);
  assert.match(formatted.text, /Use a single entry ID/);
});

test("pretty 召回按完整结果块截断，不切断 entry ID", () => {
  const hits = toHits([
    { type: "message", id: "entry-one", message: { role: "user", content: "first result" } },
    { type: "message", id: "entry-two", message: { role: "user", content: "second result" } },
  ]);
  const formatted = formatRecallOutput(hits, false, 180);
  assert.equal(formatted.truncated, true);
  assert.match(formatted.text, /\[entry entry-one\]/);
  assert.equal(formatted.text.includes("[entry entry-two]"), false);
  assert.equal(formatted.text.endsWith("entry-one"), false);
});

test("list 动作按最近记录做有界列出", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-compact-recall-list-"));
  try {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "pi-compact.json"), JSON.stringify(DEFAULT_CONFIG));
    let tool: any;
    const pi = { registerTool(definition: any) { tool = definition; }, registerCommand() {} };
    registerRecall(pi as any);
    const listed = await tool.execute("call-list", { action: "list", limit: 1 }, new AbortController().signal, undefined, {
      cwd,
      sessionManager: {
        getEntries: () => [
          { type: "message", id: "older", message: { role: "user", content: "old" } },
          { type: "message", id: "newer", message: { role: "user", content: "new" } },
        ],
        getBranch: () => [
          { type: "message", id: "older", message: { role: "user", content: "old" } },
          { type: "message", id: "newer", message: { role: "user", content: "new" } },
        ],
      },
    });
    assert.match(listed.content[0].text, /newer/);
    assert.equal(listed.content[0].text.includes("older"), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("长 raw 支持 offset/limit 分段读取", () => {
  const raw: SessionEntryLike = {
    type: "message",
    id: "slice-me",
    message: { role: "user", content: "abcdefghijklmnopqrstuvwxyz" },
  };
  const [hit] = toHits([raw]);
  const formatted = formatRecallOutput([hit], true, 16000, false, { offset: 0, limit: 12 });
  const parsed = JSON.parse(formatted.text);
  assert.equal(parsed.entryId, "slice-me");
  assert.equal(parsed.offset, 0);
  assert.equal(parsed.limit, 12);
  assert.equal(parsed.body.length, 12);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.totalChars > 12);
});

test("注册的召回工具按单个 entry ID 返回完整 raw JSON 和统计", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-compact-recall-"));
  try {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "pi-compact.json"), JSON.stringify({ ...DEFAULT_CONFIG, recallMaxChars: 100 }));
    const entry: SessionEntryLike = {
      type: "message",
      id: "tool-big",
      message: { role: "user", content: "r".repeat(2_000) },
    };
    let tool: any;
    const pi = {
      registerTool(definition: any) { tool = definition; },
      registerCommand() {},
    };
    registerRecall(pi as any);
    const result = await tool.execute("call", { entryIds: ["tool-big"], raw: true }, new AbortController().signal, undefined, {
      cwd,
      sessionManager: { getEntries: () => [entry], getBranch: () => [entry] },
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.id, "tool-big");
    assert.equal(result.details.count, 1);
    assert.equal(result.details.truncated, false);
    assert.ok(result.details.chars > 100);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
