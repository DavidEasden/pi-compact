import assert from "node:assert/strict";
import test from "node:test";
import { searchMemoryRecords, sortMemoryRecords } from "../src/core/memory-search.ts";
import type { MemoryRecord } from "../src/types.ts";

const memory = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: "mem_default",
  kind: "fact",
  content: "token refresh",
  scope: "project",
  status: "active",
  priority: "normal",
  author: "user",
  sourceEntryIds: [],
  sourceHash: "hash",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  version: 1,
  pinned: false,
  ...overrides,
});

test("记忆搜索综合词频、长度、短语、状态、作者和优先级排序", () => {
  const pinned = memory({ id: "pinned", status: "pinned", pinned: true, priority: "high" });
  const active = memory({ id: "active", status: "active" });
  const provisional = memory({ id: "provisional", status: "provisional", author: "model" });
  const noisy = memory({
    id: "noisy",
    content: `token refresh ${"token ".repeat(1000)}`,
    status: "provisional",
    author: "rule",
    priority: "low",
  });

  const hits = searchMemoryRecords([noisy, provisional, active, pinned], "token refresh", { now: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(hits.map((record) => record.id), ["pinned", "active", "provisional", "noisy"]);
});

test("空或停用词查询不退化为列出所有记忆", () => {
  const records = [memory({ id: "one" }), memory({ id: "two", content: "pnpm workspace" })];
  assert.deepEqual(searchMemoryRecords(records, ""), []);
  assert.deepEqual(searchMemoryRecords(records, "the and"), []);
});

test("默认列表优先 pinned、active 和高优先级用户记忆", () => {
  const records = [
    memory({ id: "derived", status: "provisional", author: "rule", priority: "low" }),
    memory({ id: "low", status: "active", author: "user", priority: "low" }),
    memory({ id: "high", status: "active", author: "user", priority: "high" }),
    memory({ id: "pinned", status: "pinned", author: "user", priority: "normal", pinned: true }),
  ];
  assert.deepEqual(sortMemoryRecords(records).map((record) => record.id), ["pinned", "high", "low", "derived"]);
});

test("模型 provisional 记忆的轻量时效信号可重复计算", () => {
  const old = memory({ id: "old", status: "provisional", author: "model", updatedAt: "2024-01-01T00:00:00.000Z" });
  const recent = memory({ id: "recent", status: "provisional", author: "model", updatedAt: "2025-12-31T00:00:00.000Z" });
  const now = "2026-01-01T00:00:00.000Z";
  assert.deepEqual(searchMemoryRecords([old, recent], "token refresh", { now }).map((record) => record.id), ["recent", "old"]);
  assert.deepEqual(searchMemoryRecords([old, recent], "token refresh", { now }).map((record) => record.id), ["recent", "old"]);
});
