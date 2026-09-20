import assert from "node:assert/strict";
import test from "node:test";
import { formatMemoryRead, formatMemorySearch, MEMORY_TOOL_MAX_CHARS } from "../src/core/memory-output.ts";
import type { MemoryRecord } from "../src/types.ts";

const record: MemoryRecord = {
  id: "mem_test", kind: "fact", scope: "project", status: "active", priority: "normal", author: "user",
  content: "正文\"\\\n".repeat(10000), sourceEntryIds: [], sourceHash: "hash",
  createdAt: "2026-01-01", updatedAt: "2026-01-01", version: 1, pinned: false,
};

test("异常长 ID、哈希和日期也不能突破读取 JSON 的硬预算", () => {
  const huge = { ...record, id: "i".repeat(20000), sourceHash: "h".repeat(20000), createdAt: "t".repeat(20000) };
  const result = formatMemoryRead(huge, { limit: 1000000 });
  assert.ok(result.text.length <= MEMORY_TOOL_MAX_CHARS);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.metadataTruncated, true);
  assert.ok(parsed.content.length > 0);
  assert.equal(parsed.content, record.content.slice(0, parsed.nextOffset));
});

test("无剩余正文的读取正确结束分页，长标题搜索仍标记截断", () => {
  const finished = formatMemoryRead(record, { offset: record.content.length });
  assert.equal(finished.truncated, false);
  assert.equal(JSON.parse(finished.text).content, "");
  const search = formatMemorySearch([{ ...record, content: "短正文", id: "i".repeat(20000) }]);
  assert.ok(search.text.length <= MEMORY_TOOL_MAX_CHARS);
  assert.equal(search.truncated, true);
});
