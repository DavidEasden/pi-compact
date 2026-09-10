import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir } from "./jsonl.ts";

/* ------------------------------------------------------------------ */
/* 同步文件锁：保护 append 事务（读末条 -> 算 seq/prevHash -> append）的跨进程原子性。 */
/* ------------------------------------------------------------------ */

/** 获取锁的最长等待；可用 PI_COMPACT_LOCK_TIMEOUT_MS 覆盖（主要供测试）。仅是等待超时，不是活锁租约。 */
const lockTimeoutMs = (): number => {
  const parsed = Number(process.env.PI_COMPACT_LOCK_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 100 ? parsed : 5000;
};
const LOCK_POLL_MS = 10;

/** 可用同步 ps 读取启动时间的 Unix 平台（不含 Linux，Linux 走 /proc）。 */
const UNIX_PS_PLATFORMS = new Set(["darwin", "freebsd", "openbsd", "netbsd", "sunos", "aix"]);

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
}

export type ProcessStartTimeKind = "linux" | "unix-ps" | "windows";

export interface ProcessStartTimeReaders {
  linux?: (pid: number) => string | undefined;
  unixPs?: (pid: number) => string | undefined;
  windows?: (pid: number) => string | undefined;
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

/** 解析 ps / PowerShell 的同步输出；非 0 或空文本视为无法读取。 */
export const parseSpawnedStartTime = (result: { status: number | null; stdout?: string | null } | undefined): string | undefined => {
  if (!result || result.status !== 0) return undefined;
  const text = (result.stdout ?? "").trim();
  return text.length > 0 ? text : undefined;
};

/** ps 的 lstart 会受时区影响，固定为 UTC 以便跨进程稳定比较。 */
const unixPsStartTime = (pid: number): string | undefined => {
  try {
    return parseSpawnedStartTime(spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TZ: "UTC" },
    }));
  } catch {
    return undefined;
  }
};

const windowsStartTime = (pid: number): string | undefined => {
  try {
    return parseSpawnedStartTime(spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
    ], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }));
  } catch {
    return undefined;
  }
};

/** 按平台选择启动时间读取方式；未知平台不声称可读。 */
export const processStartTimeKind = (platform: string): ProcessStartTimeKind | undefined => {
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  if (UNIX_PS_PLATFORMS.has(platform)) return "unix-ps";
  return undefined;
};

/**
 * 读取进程启动时间。Linux 用 /proc/<pid>/stat；macOS 及其他可用 Unix 用同步 ps；
 * Windows 用 PowerShell Get-Process StartTime。读取失败或未知平台返回 undefined。
 */
export const readProcessStartTimeForPlatform = (
  pid: number,
  platform: string,
  readers: ProcessStartTimeReaders = {},
): string | undefined => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const kind = processStartTimeKind(platform);
  try {
    if (kind === "linux") return (readers.linux ?? linuxStartTime)(pid);
    if (kind === "unix-ps") return (readers.unixPs ?? unixPsStartTime)(pid);
    if (kind === "windows") return (readers.windows ?? windowsStartTime)(pid);
    return undefined;
  } catch {
    return undefined;
  }
};

export const readProcessStartTime = (pid: number): string | undefined => readProcessStartTimeForPlatform(pid, process.platform);

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
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof parsed.token !== "string" || parsed.token.length === 0) return undefined;
    const ts = Number(parsed.ts);
    const startTime = lockStartTime(parsed.startTime);
    return { pid, token: parsed.token, ts: Number.isFinite(ts) ? ts : 0, startTime };
  } catch {
    return undefined;
  }
};

/**
 * 锁可恢复：持有进程已死、PID 复用（启动时间明确不一致），
 * 或能用当前进程启动时间证明是本进程遗留且当前未持有。
 * 活进程不得按年龄回收；缺失 metadata 或无法验证身份时必须保守等待。
 */
export const isRecoverableLock = (path: string, info: LockInfo | undefined, options: LockRecoveryOptions = {}): boolean => {
  const selfPid = options.pid ?? process.pid;
  const held = options.held ?? heldLocks.has(path);
  const alive = options.alive ?? processAlive;
  const startTimeOf = options.startTime ?? readProcessStartTime;
  if (!info) return false;
  if (info.pid === selfPid) {
    if (held) return false;
    if (!info.startTime) return false;
    const liveStart = startTimeOf(selfPid);
    // 启动时间明确可比：相等为本进程遗留，不等为 PID 复用，均可回收。
    return liveStart !== undefined;
  }
  if (!alive(info.pid)) return true;
  if (info.startTime) {
    const liveStart = startTimeOf(info.pid);
    if (liveStart !== undefined && liveStart !== info.startTime) return true;
  }
  return false;
};

/** 仅当 expected 与当前锁的 owner token/pid/startTime 完全一致时才删除；缺失 expected 或无法解析时不删除。 */
export const reclaimLock = (path: string, expected: LockInfo | undefined): void => {
  try {
    if (!expected) return;
    const current = readLockInfo(path);
    if (!current) return;
    if (current.token !== expected.token) return;
    if (current.pid !== expected.pid) return;
    if (current.startTime !== expected.startTime) return;
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
      throw new Error(`pi-compact: 获取日志锁超时（${timeoutMs}ms）：${path}，所有者 metadata 无法验证或锁仍被持有，本次写入未完成`);
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
