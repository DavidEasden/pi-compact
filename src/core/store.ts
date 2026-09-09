import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryEvent, MemoryRecord, WindowEvent, WindowManifest } from "../types.ts";
import { appendJsonl, ensureDir, hashText, readJsonl, stableHash } from "./jsonl.ts";
import { isMemoryEvent, projectMemories } from "./projector.ts";

export const storeDir = (cwd: string): string => join(cwd, ".pi", "pi-compact");
export const memoryLogPath = (cwd: string): string => join(storeDir(cwd), "memory.jsonl");
export const windowLogPath = (cwd: string): string => join(storeDir(cwd), "windows.jsonl");

export const ensureStore = (cwd: string): string => {
  const directory = storeDir(cwd);
  ensureDir(directory);
  return directory;
};

export const newMemoryId = (): string => `mem_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const newWindowId = (sourceHash: string, seq: number): string => `win_${seq.toString(16)}_${sourceHash.slice(0, 8)}`;

const eventForHash = (event: MemoryEvent): unknown => ({
  seq: event.seq,
  ts: event.ts,
  type: event.type,
  recordId: event.recordId,
  prevHash: event.prevHash,
  author: event.author,
  sessionId: event.sessionId ?? "",
  payload: event.payload,
});

export const hashMemoryEvent = (event: Omit<MemoryEvent, "hash"> | MemoryEvent): string => stableHash(eventForHash(event as MemoryEvent));

const windowForHash = (event: WindowEvent): unknown => ({
  seq: event.seq,
  ts: event.ts,
  type: event.type,
  windowId: event.windowId,
  parentWindowId: event.parentWindowId ?? "",
  keptEntryId: event.keptEntryId,
  sourceCount: event.sourceCount,
  sourceHash: event.sourceHash,
  previousHash: event.previousHash,
  sourceEntryIds: event.sourceEntryIds,
  reason: event.reason,
  isSplitTurn: event.isSplitTurn,
  firstSourceEntryId: event.firstSourceEntryId ?? "",
  lastSourceEntryId: event.lastSourceEntryId ?? "",
  sessionId: event.sessionId ?? "",
  prevHash: event.prevHash,
});

export const hashWindowEvent = (event: Omit<WindowEvent, "hash"> | WindowEvent): string => stableHash(windowForHash(event as WindowEvent));

/* ------------------------------------------------------------------ */
/* 同步文件锁：保护 append 事务（读末条 -> 算 seq/prevHash -> append）的跨进程原子性。 */
/* ------------------------------------------------------------------ */

/** 获取锁的最长等待；可用 PI_COMPACT_LOCK_TIMEOUT_MS 覆盖（主要供测试）。 */
const lockTimeoutMs = (): number => {
  const parsed = Number(process.env.PI_COMPACT_LOCK_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 100 ? parsed : 5000;
};
/** 持锁进程仍存活但超过该时长视为死锁/过期，可被回收。 */
const lockStaleMs = (): number => Math.max(1000, lockTimeoutMs() * 2);
const LOCK_POLL_MS = 10;

interface HeldLock {
  token: string;
  depth: number;
}

/** 进程内重入计数：同一路径重复获取只增加深度，嵌套事务不会自锁。 */
const heldLocks = new Map<string, HeldLock>();

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

interface LockInfo {
  pid: number;
  token: string;
  ts: number;
}

const readLockInfo = (path: string): LockInfo | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const pid = Number(parsed.pid);
    if (!Number.isSafeInteger(pid) || typeof parsed.token !== "string") return undefined;
    const ts = Number(parsed.ts);
    return { pid, token: parsed.token, ts: Number.isFinite(ts) ? ts : 0 };
  } catch {
    return undefined;
  }
};

const lockAgeMs = (path: string): number => {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/** 锁可恢复：内容无法解析（残留垃圾）、持有进程已死、本进程遗留、或持锁超过过期阈值。 */
const isRecoverableLock = (path: string, info: LockInfo | undefined): boolean => {
  if (!info) return true;
  if (info.pid === process.pid) return !heldLocks.has(path);
  if (!processAlive(info.pid)) return true;
  return lockAgeMs(path) > lockStaleMs();
};

/** 仅当锁内容仍是之前读到的 token 时才删除，避免误删他人随后获取的新锁。 */
const reclaimLock = (path: string, expected: LockInfo | undefined): void => {
  try {
    const current = readLockInfo(path);
    if (current?.token !== expected?.token) return;
    unlinkSync(path);
  } catch {
    // 锁文件已被其他进程回收。
  }
};

const acquireLock = (path: string): void => {
  const held = heldLocks.get(path);
  if (held) {
    held.depth += 1;
    return;
  }
  const token = `${process.pid}:${randomUUID()}`;
  const timeoutMs = lockTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx");
      writeSync(fd, `${JSON.stringify({ pid: process.pid, token, ts: Date.now() })}\n`);
      heldLocks.set(path, { token, depth: 1 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`pi-compact: 无法创建日志锁 ${path}：${(error as Error).message}`);
      }
      const info = readLockInfo(path);
      if (isRecoverableLock(path, info)) reclaimLock(path, info);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (Date.now() >= deadline) {
      throw new Error(`pi-compact: 获取日志锁超时（${timeoutMs}ms）：${path}，本次写入未完成`);
    }
    sleepSync(LOCK_POLL_MS);
  }
};

const releaseLock = (path: string): void => {
  const held = heldLocks.get(path);
  if (!held) return;
  held.depth -= 1;
  if (held.depth > 0) return;
  heldLocks.delete(path);
  reclaimLock(path, { pid: process.pid, token: held.token, ts: 0 });
};

/** 保护单个日志文件完整事务；finally 释放，异常向上抛出，不静默吞写。 */
export const withLogLock = <T>(logPath: string, fn: () => T): T => {
  const lockPath = `${logPath}.lock`;
  ensureDir(dirname(lockPath));
  acquireLock(lockPath);
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
};

export const withMemoryLogLock = <T>(cwd: string, fn: () => T): T => withLogLock(memoryLogPath(cwd), fn);
export const withWindowLogLock = <T>(cwd: string, fn: () => T): T => withLogLock(windowLogPath(cwd), fn);

const isWindowEvent = (value: unknown): value is WindowEvent => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return Number.isSafeInteger(event.seq)
    && typeof event.ts === "string"
    && event.type === "open"
    && typeof event.windowId === "string"
    && typeof event.keptEntryId === "string"
    && typeof event.sourceHash === "string"
    && typeof event.previousHash === "string"
    && typeof event.hash === "string"
    && typeof event.prevHash === "string"
    && Array.isArray(event.sourceEntryIds);
};

/**
 * 严格链校验：seq 必须从 1 起严格连续，prevHash 必须等于上一条被接受事件的 hash。
 * 遇到首个非法/断链/重复/跳号事件即停止，只保留可信前缀，不跳过后接收后续。
 */
const trustedPrefix = <T extends { seq: number; prevHash: string; hash: string }>(
  rows: unknown[],
  isEvent: (value: unknown) => value is T,
  hashOf: (event: T) => string,
): T[] => {
  const events: T[] = [];
  let expectedSeq = 1;
  let prevHash = "";
  for (const row of rows) {
    if (!isEvent(row)) break;
    if (row.seq !== expectedSeq || row.prevHash !== prevHash) break;
    if (row.hash !== hashOf(row)) break;
    events.push(row);
    expectedSeq += 1;
    prevHash = row.hash;
  }
  return events;
};

/**
 * 在追加事务内使用：读取原始可解析行并计算可信前缀。
 * 若可信事件数不等于可解析行总数，说明日志在可信前缀后存在不接受的事件，
 * 此时追加只会让新事件物理落在坏行之后且永远不可见，必须拒绝并要求人工修复。
 * 不通过截断、重写或自动修复来隐藏问题。EOF 半行不可解析，不计入可解析行，因此仍可追加。
 */
const appendableEvents = <T extends { seq: number; prevHash: string; hash: string }>(
  logPath: string,
  logName: string,
  isEvent: (value: unknown) => value is T,
  hashOf: (event: T) => string,
): T[] => {
  const rows = readJsonl(logPath);
  const events = trustedPrefix(rows, isEvent, hashOf);
  if (events.length !== rows.length) {
    throw new Error(
      `pi-compact: ${logName} 日志在可信前缀之后存在不接受的事件（可信 ${events.length} 条 / 可解析 ${rows.length} 行），已拒绝追加。` +
        `请先人工修复日志（校验并移除坏行、重建哈希链）后再写入；不会自动截断或重写日志。`,
    );
  }
  return events;
};

export const readMemoryEvents = (cwd: string): MemoryEvent[] => trustedPrefix(readJsonl(memoryLogPath(cwd)), isMemoryEvent, hashMemoryEvent);

export const readWindowEvents = (cwd: string): WindowEvent[] => trustedPrefix(readJsonl(windowLogPath(cwd)), isWindowEvent, hashWindowEvent);

export const loadMemories = (cwd: string): MemoryRecord[] => projectMemories(readMemoryEvents(cwd));

export type MemoryEventInput = Omit<MemoryEvent, "seq" | "ts" | "prevHash" | "hash"> & { ts?: string };

export const appendMemoryEvent = (cwd: string, input: MemoryEventInput): MemoryEvent => {
  ensureStore(cwd);
  return withMemoryLogLock(cwd, (): MemoryEvent => {
    const existing = appendableEvents(memoryLogPath(cwd), "memory.jsonl", isMemoryEvent, hashMemoryEvent);
    const last = existing.at(-1);
    const event: MemoryEvent = {
      ...input,
      seq: (last?.seq ?? 0) + 1,
      ts: input.ts ?? new Date().toISOString(),
      prevHash: last?.hash ?? "",
      hash: "",
    };
    event.hash = hashMemoryEvent(event);
    appendJsonl(memoryLogPath(cwd), event);
    return event;
  });
};

export const appendWindowEvent = (cwd: string, manifest: WindowManifest): WindowEvent => {
  ensureStore(cwd);
  return withWindowLogLock(cwd, (): WindowEvent => {
    const existing = appendableEvents(windowLogPath(cwd), "windows.jsonl", isWindowEvent, hashWindowEvent);
    const last = existing.at(-1);
    const event: WindowEvent = {
      seq: (last?.seq ?? 0) + 1,
      ts: manifest.createdAt,
      type: "open",
      windowId: manifest.windowId,
      parentWindowId: manifest.parentWindowId,
      keptEntryId: manifest.keptEntryId,
      sourceCount: manifest.sourceCount,
      sourceHash: manifest.sourceHash,
      previousHash: manifest.previousHash,
      sourceEntryIds: manifest.sourceEntryIds,
      reason: manifest.reason,
      isSplitTurn: manifest.isSplitTurn,
      firstSourceEntryId: manifest.firstSourceEntryId,
      lastSourceEntryId: manifest.lastSourceEntryId,
      sessionId: manifest.sessionId,
      prevHash: last?.hash ?? "",
      hash: "",
    };
    event.hash = hashWindowEvent(event);
    appendJsonl(windowLogPath(cwd), event);
    return event;
  });
};

export const contentHash = (content: string): string => hashText(content);
