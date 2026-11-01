/* 手动性能基准：node --import tsx scripts/bench.mjs；不作为 CI 时间断言。 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageFiles } from "../src/core/content.ts";
import { recordsFromEntries, searchRecords } from "../src/core/session.ts";
import { appendMemoryEvents, readMemoryEvents } from "../src/core/store.ts";
import { appendSessionSummary, readSessionSummaryEvents, renderSessionSummary } from "../src/core/summary.ts";

const time = (label, fn, iterations = 1) => {
  fn();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  console.log(`${label}: ${((performance.now() - started) / iterations).toFixed(2)} ms/op`);
};

const tempCwd = (prefix) => {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  return cwd;
};

const text = "function parseConfig(path) { return readFileSync(path, 'utf8'); } // 配置加载 ".repeat(40).slice(0, 2400);
const entries = Array.from({ length: 1000 }, (_, i) => ({
  id: `e${i}`, type: "message", timestamp: new Date(1600000000000 + i * 1000).toISOString(),
  message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `${text} turn ${i}` }] },
}));
entries.push({
  id: "big", type: "message", timestamp: new Date().toISOString(),
  message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "word ".repeat(320000) }] },
});
const records = recordsFromEntries(entries);
console.log(`search corpus: entries=${entries.length} chars=${records.reduce((n, record) => n + record.text.length, 0)}`);
time("recordsFromEntries", () => recordsFromEntries(entries), 5);
time("searchRecords (1001 entries, 1.6MB toolResult)", () => searchRecords(records, "配置", { maxResults: 8 }), 5);

const appendCwd = tempCwd("pi-compact-bench-append-");
try {
  const make = (i) => ({
    type: "create", recordId: `mem_${i}`, author: "model",
    payload: { kind: "fact", content: "x".repeat(400), scope: "workspace", status: "provisional", priority: "normal", sourceEntryIds: [], sourceHash: `h${i}` },
  });
  appendMemoryEvents(appendCwd, Array.from({ length: 400 }, (_, i) => make(i)));
  const batch = Array.from({ length: 50 }, (_, i) => make(`batch_${i}`));
  time("appendMemoryEvents (50, after 400)", () => appendMemoryEvents(appendCwd, batch), 3);
  console.log(`memory events: ${readMemoryEvents(appendCwd).length}`);
} finally {
  rmSync(appendCwd, { recursive: true, force: true });
}

const summaryCwd = tempCwd("pi-compact-bench-summary-");
try {
  const rec = (id, text, ordinal) => ({
    entryId: id, kinds: ["user"], text, files: [`src/file-${id}.ts`], toolCallIds: [], sourceOrdinal: ordinal,
    raw: { id, text }, sourceClass: "primary",
  });
  let parent;
  for (let i = 0; i < 20; i++) {
    parent = appendSessionSummary({
      cwd: summaryCwd, sessionId: "bench-session", compactionEntryId: `cp${i}`,
      parentCompactionEntryId: parent, sourceHash: `hash-${i}`, maxEvidence: 80,
      records: Array.from({ length: 8 }, (_, j) => rec(`u${i}_${j}`, `用户需求 ${i}-${j} ${"内容".repeat(120)}`, j)),
    }).compactionEntryId;
  }
  const directory = join(summaryCwd, ".pi", "pi-compact", "sessions");
  const file = join(directory, readdirSync(directory)[0]);
  const latest = readSessionSummaryEvents(summaryCwd, "bench-session").at(-1);
  console.log(`summary file: ${statSync(file).size} bytes, rows=${readFileSync(file, "utf8").trim().split("\n").length}`);
  time("readSessionSummaryEvents (20 events)", () => readSessionSummaryEvents(summaryCwd, "bench-session"), 20);
  time("renderSessionSummary (6000 chars)", () => renderSessionSummary(latest, 6000), 50);
} finally {
  rmSync(summaryCwd, { recursive: true, force: true });
}

const nested = { rows: Array.from({ length: 20000 }, (_, i) => ({ path: `src/file-${i}.ts`, cwd: "/project" })) };
time("messageFiles (20k nested paths)", () => messageFiles({ role: "toolResult", content: [nested] }), 5);
