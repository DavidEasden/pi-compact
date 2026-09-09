import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { deriveFacts } from "../src/core/derive.ts";
import { projectMemories } from "../src/core/projector.ts";
import { recordsFromEntries } from "../src/core/session.ts";
import {
  appendMemoryEvent,
  appendWindowEvent,
  hashMemoryEvent,
  hashWindowEvent,
  loadMemories,
  memoryLogPath,
  readMemoryEvents,
  readWindowEvents,
  windowLogPath,
} from "../src/core/store.ts";
import { buildWindowManifest, persistWindowManifest } from "../src/core/window.ts";
import { renderWorkingHint } from "../src/core/working.ts";
import { registerHooks } from "../src/hooks.ts";
import { registerMemory } from "../src/memory.ts";
import type { MemoryEvent, MemoryRecord, SessionEntryLike, WindowManifest } from "../src/types.ts";

const tempCwd = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-compact-memory-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "pi-compact.json"), `${JSON.stringify(DEFAULT_CONFIG)}\n`);
  return cwd;
};

const event = (overrides: Partial<MemoryEvent> & Pick<MemoryEvent, "type" | "recordId" | "payload">): MemoryEvent => ({
  seq: 1,
  ts: "2024-01-01T00:00:00.000Z",
  prevHash: "",
  hash: "test",
  author: "user",
  ...overrides,
});

const createPayload = (content: string, status: "provisional" | "active" = "active") => ({
  kind: "fact" as const,
  content,
  scope: "project" as const,
  status,
  priority: "normal" as const,
  sourceEntryIds: [] as string[],
  sourceHash: content,
});

/** 非空物理行数：验证拒绝追加后日志不再新增任何内容。 */
const lineCount = (path: string): number => readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).length;

test("事件重放是确定性的，重复 seq 不会覆盖首次事件", () => {
  const events: MemoryEvent[] = [
    event({ seq: 1, recordId: "mem_a", type: "create", payload: createPayload("first") }),
    event({ seq: 1, recordId: "mem_b", type: "create", payload: createPayload("duplicate-seq") }),
    event({ seq: 2, ts: "2024-01-01T00:00:01.000Z", recordId: "mem_a", type: "create", payload: createPayload("overwrite") }),
    event({ seq: 3, ts: "2024-01-01T00:00:02.000Z", recordId: "mem_c", type: "create", payload: createPayload("third") }),
  ];
  const first = projectMemories(events);
  const second = projectMemories(events);
  assert.deepEqual(first.map((record) => ({ id: record.id, content: record.content, status: record.status })), second.map((record) => ({ id: record.id, content: record.content, status: record.status })));
  const shuffled = projectMemories([
    event({ seq: 3, ts: "2024-01-01T00:00:02.000Z", recordId: "mem_c", type: "create", payload: createPayload("third") }),
    event({ seq: 1, recordId: "mem_a", type: "create", payload: createPayload("first") }),
  ]);
  assert.equal(shuffled.map((record) => record.id).sort().join(","), "mem_a,mem_c");
  assert.equal(first.find((record) => record.id === "mem_a")?.content, "first");
  assert.equal(first.some((record) => record.id === "mem_b"), false);
  assert.equal(first.find((record) => record.id === "mem_c")?.content, "third");
});

test("supersede 与 pin 建立版本关系，且不会改写已终结记录", () => {
  const events: MemoryEvent[] = [
    event({ seq: 1, recordId: "mem_old", type: "create", payload: createPayload("v1") }),
    event({ seq: 2, ts: "2024-01-01T00:00:01.000Z", recordId: "mem_old", type: "pin", payload: {} }),
    event({
      seq: 3,
      ts: "2024-01-01T00:00:02.000Z",
      recordId: "mem_old",
      type: "supersede",
      payload: { newRecordId: "mem_new", content: "v2", status: "active", sourceHash: "v2" },
    }),
    event({ seq: 4, ts: "2024-01-01T00:00:03.000Z", recordId: "mem_new", type: "pin", payload: {} }),
    event({ seq: 5, ts: "2024-01-01T00:00:04.000Z", recordId: "mem_old", type: "pin", payload: {} }),
    event({ seq: 6, ts: "2024-01-01T00:00:05.000Z", recordId: "mem_old", type: "resolve", payload: {} }),
  ];
  const records = projectMemories(events);
  const old = records.find((record) => record.id === "mem_old")!;
  const next = records.find((record) => record.id === "mem_new")!;
  assert.equal(old.status, "superseded");
  assert.equal(old.supersededBy, "mem_new");
  assert.equal(old.pinned, false);
  assert.equal(next.status, "pinned");
  assert.equal(next.supersedes, "mem_old");
  assert.equal(next.version, 2);
  assert.equal(next.content, "v2");
});

test("重启后从日志重建：EOF 半行可容忍追加，断链后拒绝追加", () => {
  const cwd = tempCwd();
  try {
    appendMemoryEvent(cwd, { type: "create", recordId: "mem_ok1", author: "user", payload: createPayload("alpha") });
    appendMemoryEvent(cwd, { type: "pin", recordId: "mem_ok1", author: "user", payload: {} });
    appendFileSync(memoryLogPath(cwd), "{\"seq\":99,\"partial");
    // EOF 半行不可解析，不计入可解析行：追加仍允许，seal 后新事件可被重建。
    appendMemoryEvent(cwd, { type: "create", recordId: "mem_ok2", author: "user", payload: createPayload("beta") });
    const rebuilt = loadMemories(cwd);
    assert.deepEqual(rebuilt.map((record) => record.id).sort(), ["mem_ok1", "mem_ok2"]);
    assert.equal(rebuilt.find((record) => record.id === "mem_ok1")?.status, "pinned");
    assert.equal(readFileSync(memoryLogPath(cwd), "utf8").includes("partial"), true);

    appendFileSync(memoryLogPath(cwd), `${JSON.stringify({ seq: 50, ts: "t", type: "create", recordId: "mem_bad", prevHash: "", hash: "nope", author: "user", payload: createPayload("bad") })}\n`);
    // 断链之后追加被拒绝：抛出明确错误，不产生任何新物理事件。
    const before = lineCount(memoryLogPath(cwd));
    assert.throws(
      () => appendMemoryEvent(cwd, { type: "create", recordId: "mem_ok3", author: "user", payload: createPayload("gamma") }),
      /可信前缀之后存在不接受的事件.*已拒绝追加.*人工修复/,
    );
    assert.equal(lineCount(memoryLogPath(cwd)), before);
    assert.equal(readFileSync(memoryLogPath(cwd), "utf8").includes("mem_ok3"), false);
    const again = loadMemories(cwd);
    assert.deepEqual(again.map((record) => record.id).sort(), ["mem_ok1", "mem_ok2"]);
    assert.equal(again.find((record) => record.id === "mem_ok1")?.status, "pinned");
    assert.equal(readMemoryEvents(cwd).every((item) => item.hash.length === 64), true);
    assert.equal(readFileSync(memoryLogPath(cwd), "utf8").includes("partial"), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("跨进程并发写入被文件锁串行化，memory/window seq 连续无丢失", async () => {
  const cwd = tempCwd();
  try {
    const storeUrl = new URL("../src/core/store.ts", import.meta.url).href;
    const scriptPath = join(cwd, "worker.ts");
    writeFileSync(scriptPath, `import { appendMemoryEvent, appendWindowEvent } from ${JSON.stringify(storeUrl)};
const cwd = process.argv[2];
const worker = process.argv[3] ?? "0";
for (let index = 0; index < 10; index++) {
  appendMemoryEvent(cwd, { type: "create", recordId: \`mem_w\${worker}_\${index}\`, author: "user", payload: { kind: "fact", content: \`w\${worker}-\${index}\`, scope: "project", status: "active", priority: "normal", sourceEntryIds: [], sourceHash: \`w\${worker}-\${index}\` } });
  appendWindowEvent(cwd, { windowId: \`win_w\${worker}_\${index}\`, keptEntryId: "k", sourceCount: 1, sourceHash: "s", previousHash: "", sourceEntryIds: ["e"], reason: "manual", isSplitTurn: false, createdAt: new Date().toISOString(), sessionId: "s" });
}
`);
    const projectRoot = fileURLToPath(new URL("..", import.meta.url));
    const children = [0, 1, 2, 3].map((worker) => spawn(process.execPath, ["--import", "tsx", scriptPath, cwd, String(worker)], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] }));
    const codes = await Promise.all(children.map((child) => new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)))));
    assert.deepEqual(codes, [0, 0, 0, 0]);
    const events = readMemoryEvents(cwd);
    assert.equal(events.length, 40);
    assert.deepEqual(events.map((item) => item.seq), Array.from({ length: 40 }, (_, index) => index + 1));
    assert.equal(new Set(events.map((item) => item.recordId)).size, 40);
    const windows = readWindowEvents(cwd);
    assert.equal(windows.length, 40);
    assert.deepEqual(windows.map((item) => item.seq), Array.from({ length: 40 }, (_, index) => index + 1));
    assert.equal(existsSync(`${memoryLogPath(cwd)}.lock`), false);
    assert.equal(existsSync(`${windowLogPath(cwd)}.lock`), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("锁超时明确报错，残留/死亡进程锁可恢复且不永久阻塞", async () => {
  const cwd = tempCwd();
  const lockPath = `${memoryLogPath(cwd)}.lock`;
  try {
    mkdirSync(join(cwd, ".pi", "pi-compact"), { recursive: true });
    // 无法解析的锁文件视为残留垃圾，自动恢复。
    writeFileSync(lockPath, "not-json\n");
    appendMemoryEvent(cwd, { type: "create", recordId: "mem_a", author: "user", payload: createPayload("alpha") });
    assert.equal(existsSync(lockPath), false);

    // 活进程持有的新鲜锁：有限超时后抛出明确错误，不静默丢失写入。
    const holder = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000);"], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve) => holder.stdout.on("data", () => resolve()));
    try {
      writeFileSync(lockPath, `${JSON.stringify({ pid: holder.pid, token: "other-holder", ts: Date.now() })}\n`);
      const previous = process.env.PI_COMPACT_LOCK_TIMEOUT_MS;
      process.env.PI_COMPACT_LOCK_TIMEOUT_MS = "200";
      try {
        assert.throws(
          () => appendMemoryEvent(cwd, { type: "create", recordId: "mem_b", author: "user", payload: createPayload("beta") }),
          /获取日志锁超时/,
        );
      } finally {
        if (previous === undefined) delete process.env.PI_COMPACT_LOCK_TIMEOUT_MS;
        else process.env.PI_COMPACT_LOCK_TIMEOUT_MS = previous;
      }
      // 持有进程死亡后锁自动回收，后续写入恢复，不留下永久锁。
      holder.kill();
      await new Promise<void>((resolve) => holder.on("exit", () => resolve()));
      appendMemoryEvent(cwd, { type: "create", recordId: "mem_c", author: "user", payload: createPayload("gamma") });
      assert.equal(existsSync(lockPath), false);
      assert.deepEqual(readMemoryEvents(cwd).map((item) => item.recordId), ["mem_a", "mem_c"]);
    } finally {
      holder.kill();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("memory 断链/跳号/重复 seq 后拒绝追加，只保留可信前缀", () => {
  const cwd = tempCwd();
  try {
    appendMemoryEvent(cwd, { type: "create", recordId: "mem_a", author: "user", payload: createPayload("a") });
    appendMemoryEvent(cwd, { type: "create", recordId: "mem_b", author: "user", payload: createPayload("b") });
    // 单条 hash 自洽但 prevHash 断链：从该事件起停止接收，且追加被拒绝。
    const broken = event({ seq: 3, recordId: "mem_c", type: "create", payload: createPayload("c"), prevHash: "0".repeat(64) });
    broken.hash = hashMemoryEvent(broken);
    appendFileSync(memoryLogPath(cwd), `${JSON.stringify(broken)}\n`);
    const before = lineCount(memoryLogPath(cwd));
    assert.throws(
      () => appendMemoryEvent(cwd, { type: "create", recordId: "mem_d", author: "user", payload: createPayload("d") }),
      /可信前缀之后存在不接受的事件.*已拒绝追加.*人工修复/,
    );
    assert.equal(lineCount(memoryLogPath(cwd)), before);
    assert.equal(readFileSync(memoryLogPath(cwd), "utf8").includes("mem_d"), false);
    assert.deepEqual(readMemoryEvents(cwd).map((item) => item.recordId), ["mem_a", "mem_b"]);
    assert.deepEqual(loadMemories(cwd).map((record) => record.id).sort(), ["mem_a", "mem_b"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  const skipCwd = tempCwd();
  try {
    appendMemoryEvent(skipCwd, { type: "create", recordId: "mem_a", author: "user", payload: createPayload("a") });
    const skipped = event({ seq: 3, recordId: "mem_x", type: "create", payload: createPayload("x"), prevHash: readMemoryEvents(skipCwd)[0].hash });
    skipped.hash = hashMemoryEvent(skipped);
    appendFileSync(memoryLogPath(skipCwd), `${JSON.stringify(skipped)}\n`);
    assert.equal(readMemoryEvents(skipCwd).length, 1);
    const before = lineCount(memoryLogPath(skipCwd));
    assert.throws(
      () => appendMemoryEvent(skipCwd, { type: "create", recordId: "mem_y", author: "user", payload: createPayload("y") }),
      /已拒绝追加/,
    );
    assert.equal(lineCount(memoryLogPath(skipCwd)), before);
  } finally {
    rmSync(skipCwd, { recursive: true, force: true });
  }

  const dupCwd = tempCwd();
  try {
    appendMemoryEvent(dupCwd, { type: "create", recordId: "mem_a", author: "user", payload: createPayload("a") });
    const duplicated = event({ seq: 1, recordId: "mem_dup", type: "create", payload: createPayload("dup"), prevHash: "" });
    duplicated.hash = hashMemoryEvent(duplicated);
    appendFileSync(memoryLogPath(dupCwd), `${JSON.stringify(duplicated)}\n`);
    assert.equal(readMemoryEvents(dupCwd).length, 1);
    const before = lineCount(memoryLogPath(dupCwd));
    assert.throws(
      () => appendMemoryEvent(dupCwd, { type: "create", recordId: "mem_z", author: "user", payload: createPayload("z") }),
      /已拒绝追加/,
    );
    assert.equal(lineCount(memoryLogPath(dupCwd)), before);
  } finally {
    rmSync(dupCwd, { recursive: true, force: true });
  }
});

const windowManifest = (index: number): WindowManifest => ({
  windowId: `win_${index}`,
  keptEntryId: `k${index}`,
  sourceCount: 1,
  sourceHash: `hash-${index}`,
  previousHash: "",
  sourceEntryIds: [`e${index}`],
  reason: "manual",
  isSplitTurn: false,
  createdAt: `2024-01-01T00:00:0${index}.000Z`,
  sessionId: "s1",
});

test("window 断链后拒绝追加，只保留可信前缀", () => {
  const cwd = tempCwd();
  try {
    appendWindowEvent(cwd, windowManifest(1));
    appendWindowEvent(cwd, windowManifest(2));
    const broken = {
      seq: 3,
      ts: "2024-01-01T00:00:03.000Z",
      type: "open" as const,
      windowId: "win_bad",
      keptEntryId: "k",
      sourceCount: 1,
      sourceHash: "s",
      previousHash: "",
      sourceEntryIds: ["e"],
      reason: "manual" as const,
      isSplitTurn: false,
      prevHash: "f".repeat(64),
      hash: "",
    };
    broken.hash = hashWindowEvent(broken);
    appendFileSync(windowLogPath(cwd), `${JSON.stringify(broken)}\n`);
    const before = lineCount(windowLogPath(cwd));
    assert.throws(
      () => appendWindowEvent(cwd, windowManifest(3)),
      /可信前缀之后存在不接受的事件.*已拒绝追加.*人工修复/,
    );
    assert.equal(lineCount(windowLogPath(cwd)), before);
    assert.equal(readFileSync(windowLogPath(cwd), "utf8").includes("win_3"), false);
    assert.deepEqual(readWindowEvents(cwd).map((item) => item.windowId), ["win_1", "win_2"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("工作记忆 hint 同轮重试递增，新用户回合重置", () => {
  const cwd = tempCwd();
  try {
    appendMemoryEvent(cwd, { type: "create", recordId: "mem_keep", author: "user", payload: createPayload("固定事实") });
    appendMemoryEvent(cwd, { type: "pin", recordId: "mem_keep", author: "user", payload: {} });
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const pi = {
      on(name: string, handler: (event: any, ctx: any) => any) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
    };
    registerHooks(pi as any);
    const context = handlers.get("context")![0];
    const entries: SessionEntryLike[] = [
      { type: "message", id: "u1", message: { role: "user", content: "第一轮" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "ok" } },
    ];
    const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1", getBranch: () => entries } };
    const hintOf = (result: any) => result?.messages?.find((message: any) => message.customType === "pi-compact-memory-hint");
    const first = context({ type: "context", messages: [{ role: "user", content: "第一轮" }] }, ctx);
    assert.equal(hintOf(first).details.sameTurnInjectionCount, 1);
    const retry = context({ type: "context", messages: [{ role: "user", content: "第一轮" }] }, ctx);
    assert.equal(hintOf(retry).details.sameTurnInjectionCount, 2);
    entries.push({ type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "第二轮" } });
    const nextTurn = context({ type: "context", messages: [{ role: "user", content: "第二轮" }] }, ctx);
    assert.equal(hintOf(nextTurn).details.sameTurnInjectionCount, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("工作记忆预算优先保留 pinned，不会被 active 挤掉", () => {
  const pinned: MemoryRecord = {
    id: "mem_pin",
    kind: "fact",
    content: "必须保留的固定事实",
    scope: "project",
    status: "pinned",
    priority: "high",
    author: "user",
    sourceEntryIds: [],
    sourceHash: "pin",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    version: 1,
    pinned: true,
  };
  const active: MemoryRecord[] = Array.from({ length: 40 }, (_, index) => ({
    ...pinned,
    id: `mem_active_${index}`,
    status: "active" as const,
    pinned: false,
    priority: "low" as const,
    content: `很长的活动记忆内容 ${"x".repeat(80)} ${index}`,
  }));
  const hint = renderWorkingHint([pinned, ...active], 500);
  assert.match(hint.content, /mem_pin/);
  assert.match(hint.content, /必须保留的固定事实/);
  assert.equal(hint.pinnedIds.includes("mem_pin"), true);
  assert.ok(hint.content.length <= 500);
  assert.equal(hint.truncated, true);
});

test("没有 pinned 记忆时仍注入查询说明", () => {
  const hint = renderWorkingHint([], 800);
  assert.match(hint.content, /当前没有 pinned 记忆/);
  assert.match(hint.content, /\/remember/);
  assert.match(hint.content, /pi_memory_search/);
  assert.match(hint.content, /pi_compact_recall/);
});

test("100 次模拟压缩后 pinned 记忆仍被注入，窗口哈希链连续", async () => {
  const cwd = tempCwd();
  try {
    appendMemoryEvent(cwd, { type: "create", recordId: "mem_keep", author: "user", payload: createPayload("跨压缩保留的事实") });
    appendMemoryEvent(cwd, { type: "pin", recordId: "mem_keep", author: "user", payload: {} });
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const pi = {
      on(name: string, handler: (event: any, ctx: any) => any) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
    };
    registerHooks(pi as any);
    const compact = handlers.get("session_before_compact")![0];
    const context = handlers.get("context")![0];
    const ctx = { cwd, ui: { notify() {} }, sessionManager: { getSessionId: () => "sess-1" } };
    for (let index = 0; index < 100; index++) {
      const userId = `u${index}`;
      const assistantId = `a${index}`;
      const branch: SessionEntryLike[] = [
        { type: "message", id: userId, message: { role: "user", content: `步骤 ${index} token 刷新` } },
        { type: "message", id: assistantId, parentId: userId, message: { role: "assistant", content: "继续" } },
      ];
      const result = await compact({
        reason: "threshold",
        branchEntries: branch,
        preparation: { firstKeptEntryId: assistantId, tokensBefore: 80, isSplitTurn: false, turnPrefixMessages: [] },
        signal: new AbortController().signal,
      }, ctx);
      assert.equal(result.compaction.details.window.previousHash === "" || result.compaction.details.window.previousHash.length === 64, true);
    }
    const windows = readWindowEvents(cwd);
    assert.equal(windows.length, 100);
    for (let index = 1; index < windows.length; index++) {
      assert.equal(windows[index].previousHash, windows[index - 1].hash);
      assert.equal(windows[index].prevHash, windows[index - 1].hash);
      assert.equal(windows[index].parentWindowId, windows[index - 1].windowId);
    }
    const injected = context({
      type: "context",
      messages: [{ role: "user", content: "请继续" }],
    }, {
      cwd,
      sessionManager: {
        getSessionId: () => "sess-1",
        getBranch: () => [{ type: "message", id: "now", message: { role: "user", content: "请继续" } }],
      },
    });
    const hint = injected.messages.find((message: any) => message.customType === "pi-compact-memory-hint");
    assert.match(hint.content, /mem_keep/);
    assert.match(hint.content, /跨压缩保留的事实/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("规则派生只提取文件、命令、退出码和测试计数", () => {
  const records = recordsFromEntries([
    { type: "message", id: "u1", message: { role: "user", content: "请判断这是不是一个目标" } },
    { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } }] } },
    { type: "message", id: "b1", message: { role: "bashExecution", command: "npm test", output: "3 passed, 1 failed", exitCode: 1 } },
  ]);
  const facts = deriveFacts(records, "hash");
  assert.ok(facts.some((fact) => fact.payload.content === "file: src/a.ts"));
  assert.ok(facts.some((fact) => fact.payload.content === "command: npm test exitCode=1"));
  assert.ok(facts.some((fact) => fact.payload.content === "tests: 3 passed, 1 failed"));
  assert.equal(facts.every((fact) => fact.payload.status === "provisional" && fact.payload.kind === "derived"), true);
  assert.equal(facts.some((fact) => fact.payload.content.includes("目标")), false);
});

test("窗口 manifest 写入哈希链并可 round-trip", () => {
  const cwd = tempCwd();
  try {
    const records = recordsFromEntries([{ type: "message", id: "u1", message: { role: "user", content: "hello" } }]);
    const first = buildWindowManifest({
      cwd,
      records,
      sourceHash: "aaa",
      keptEntryId: "a1",
      reason: "manual",
      isSplitTurn: false,
      sessionId: "s1",
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    persistWindowManifest(cwd, first);
    const second = buildWindowManifest({
      cwd,
      records,
      sourceHash: "bbb",
      keptEntryId: "a2",
      reason: "threshold",
      isSplitTurn: true,
      sessionId: "s1",
      createdAt: "2024-01-01T00:00:01.000Z",
    });
    const stored = appendWindowEvent(cwd, second);
    const roundTrip = JSON.parse(JSON.stringify(stored));
    assert.deepEqual(roundTrip, stored);
    assert.equal(stored.previousHash.length, 64);
    assert.equal(stored.parentWindowId, first.windowId);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("记忆命令与工具入口：用户写入权威，模型提议保持 provisional", async () => {
  const cwd = tempCwd();
  try {
    const notes: string[] = [];
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const pi = {
      registerTool(definition: any) { tools.set(definition.name, definition); },
      registerCommand(name: string, definition: any) { commands.set(name, definition); },
    };
    registerMemory(pi as any);
    const ctx = { cwd, ui: { notify(message: string) { notes.push(message); } }, sessionManager: { getSessionId: () => "s1" } };
    await commands.get("remember").handler("pin kind:constraint 使用 pnpm", ctx);
    const pinned = loadMemories(cwd).find((record) => record.content.includes("pnpm"))!;
    assert.equal(pinned.status, "pinned");
    assert.equal(pinned.author, "user");
    await commands.get("memories").handler("status:pinned", ctx);
    assert.ok(notes.some((note) => note.includes(pinned.id)));
    const proposed = await tools.get("pi_memory_propose").execute("c1", { content: "模型想记的事" }, new AbortController().signal, undefined, ctx);
    assert.match(proposed.content[0].text, /provisional/);
    const proposal = loadMemories(cwd).find((record) => record.content === "模型想记的事")!;
    assert.equal(proposal.status, "provisional");
    assert.equal(proposal.author, "model");
    const rejected = await tools.get("pi_memory_update").execute("c2", { recordId: pinned.id, action: "edit", content: "篡改" }, new AbortController().signal, undefined, ctx);
    assert.match(rejected.content[0].text, /不是模型 provisional/);
    assert.equal(loadMemories(cwd).find((record) => record.id === pinned.id)?.content.includes("pnpm"), true);
    const updated = await tools.get("pi_memory_update").execute("c3", { recordId: proposal.id, action: "edit", content: "更新后的提议" }, new AbortController().signal, undefined, ctx);
    assert.match(updated.content[0].text, /provisional/);
    const search = await tools.get("pi_memory_search").execute("c4", { query: "pnpm" }, new AbortController().signal, undefined, ctx);
    assert.match(search.content[0].text, /pnpm/);
    const read = await tools.get("pi_memory_read").execute("c5", { recordId: pinned.id, offset: 0, limit: 4 }, new AbortController().signal, undefined, ctx);
    const parsed = JSON.parse(read.content[0].text);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.content.length, 4);
    await commands.get("forget").handler(pinned.id, ctx);
    assert.equal(loadMemories(cwd).find((record) => record.id === pinned.id)?.status, "resolved");
    const compactTool = await tools.get("pi_compact_new_context").execute("c6", {}, new AbortController().signal, undefined, ctx);
    assert.match(compactTool.content[0].text, /\/compact/);
    assert.equal(compactTool.details.degraded, true);
    let compactCalled = false;
    const native = await tools.get("pi_compact_new_context").execute("c7", {}, new AbortController().signal, undefined, { ...ctx, compact() { compactCalled = true; } });
    assert.equal(compactCalled, true);
    assert.equal(native.details.degraded, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
