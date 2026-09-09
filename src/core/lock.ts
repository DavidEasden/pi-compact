import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir } from "./jsonl.ts";

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

export interface LockInfo {
  pid: number;
  token: string;
  ts: number;
  /** 平台进程启动时间；缺失表示写入时无法可靠取得，回收时必须保守处理。 */
  startTime?: string;
}

export interface LockRecoveryOptions {
  pid?: number;
  held?: boolean;
  alive?: (pid: number) => boolean;
  startTime?: (pid: number) => string | undefined;
  ageMs?: number;
  staleMs?: number;
}

interface HeldLock {
  info: LockInfo;
  depth: number;
}

/** 进程内重入计数：同一路径重复获取只增加深度，嵌套事务不会自锁。 */
const heldLocks = new Map<string, HeldLock>();

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const linuxStartTime = (pid: number): string | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const startTime = stat.slice(close + 2).split(" ")[19];
    return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
};

const darwinStartTime = (pid: number): string | undefined => {
  try {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return undefined;
    const text = (result.stdout ?? "").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
};

/**
 * 读取进程启动时间。Linux 用 /proc/<pid>/stat 的 starttime；macOS 用 ps lstart。
 * 其他平台或读取失败时返回 undefined，调用方必须按活锁保守处理。
 */
export const readProcessStartTime = (pid: number): string | undefined => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") return linuxStartTime(pid);
  if (process.platform === "darwin") return darwinStartTime(pid);
  return undefined;
};

const selfStartTime = readProcessStartTime(process.pid);

const lockStartTime = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

export const readLockInfo = (path: string): LockInfo | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const pid = Number(parsed.pid);
    if (!Number.isSafeInteger(pid) || typeof parsed.token !== "string" || parsed.token.length === 0) return undefined;
    const ts = Number(parsed.ts);
    const startTime = lockStartTime(parsed.startTime);
    return { pid, token: parsed.token, ts: Number.isFinite(ts) ? ts : 0, startTime };
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

/**
 * 锁可恢复：内容无法解析、本进程遗留、持有进程已死、PID 复用（启动时间不一致），或超过过期阈值。
 * PID 仍存在但无法读取启动时间时，不把锁当成死者回收，以免误删新锁。
 */
export const isRecoverableLock = (path: string, info: LockInfo | undefined, options: LockRecoveryOptions = {}): boolean => {
  const selfPid = options.pid ?? process.pid;
  const held = options.held ?? heldLocks.has(path);
  const alive = options.alive ?? processAlive;
  const startTimeOf = options.startTime ?? readProcessStartTime;
  const ageMs = options.ageMs ?? lockAgeMs(path);
  const staleMs = options.staleMs ?? lockStaleMs();
  if (!info) return true;
  if (info.pid === selfPid) return !held;
  if (!alive(info.pid)) return true;
  if (info.startTime) {
    const liveStart = startTimeOf(info.pid);
    // 启动时间能读到且与锁内记录不同：原进程已死、PID 被新进程复用，可以回收。
    if (liveStart !== undefined && liveStart !== info.startTime) return true;
  }
  return ageMs > staleMs;
};

/** 仅当锁内容仍是之前读到的 owner（token，以及 pid/startTime）时才删除，避免误删他人随后获取的新锁。 */
export const reclaimLock = (path: string, expected: LockInfo | undefined): void => {
  try {
    const current = readLockInfo(path);
    if (current?.token !== expected?.token) return;
    if (current && expected && current.pid !== expected.pid) return;
    if (current && expected && current.startTime !== expected.startTime) return;
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
  const startTimeCache = new Map<number, string | undefined>();
  const startTimeOf = (pid: number): string | undefined => {
    if (startTimeCache.has(pid)) return startTimeCache.get(pid);
    const value = readProcessStartTime(pid);
    startTimeCache.set(pid, value);
    return value;
  };
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx");
      const info: LockInfo = { pid: process.pid, token, ts: Date.now(), startTime: selfStartTime };
      writeSync(fd, `${JSON.stringify(info)}\n`);
      heldLocks.set(path, { info, depth: 1 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`pi-compact: 无法创建日志锁 ${path}：${(error as Error).message}`);
      }
      const info = readLockInfo(path);
      if (isRecoverableLock(path, info, { startTime: startTimeOf })) reclaimLock(path, info);
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
  reclaimLock(path, held.info);
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
