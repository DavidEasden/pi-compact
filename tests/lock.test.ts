import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isRecoverableLock,
  parseSpawnedStartTime,
  processStartTimeKind,
  readLockInfo,
  readProcessStartTimeForPlatform,
  reclaimLock,
  withLogLock,
  type LockInfo,
} from "../src/core/lock.ts";

const tempLock = (): { dir: string; path: string; logPath: string } => {
  const dir = mkdtempSync(join(tmpdir(), "pi-compact-lock-"));
  return { dir, path: join(dir, "memory.jsonl.lock"), logPath: join(dir, "memory.jsonl") };
};

const writeLock = (path: string, info: LockInfo): void => {
  writeFileSync(path, `${JSON.stringify(info)}\n`);
};

const withLockTimeout = (ms: string, fn: () => void): void => {
  const previous = process.env.PI_COMPACT_LOCK_TIMEOUT_MS;
  process.env.PI_COMPACT_LOCK_TIMEOUT_MS = ms;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.PI_COMPACT_LOCK_TIMEOUT_MS;
    else process.env.PI_COMPACT_LOCK_TIMEOUT_MS = previous;
  }
};

test("锁 metadata/token 不匹配时不删除", () => {
  const { dir, path } = tempLock();
  try {
    writeLock(path, { pid: 4242, token: "owner-a", ts: 1, startTime: "boot-1" });
    reclaimLock(path, { pid: 4242, token: "owner-b", ts: 1, startTime: "boot-1" });
    assert.equal(existsSync(path), true);
    assert.equal(readLockInfo(path)?.token, "owner-a");

    reclaimLock(path, { pid: 9999, token: "owner-a", ts: 1, startTime: "boot-1" });
    assert.equal(existsSync(path), true);

    reclaimLock(path, { pid: 4242, token: "owner-a", ts: 1, startTime: "boot-2" });
    assert.equal(existsSync(path), true);

    reclaimLock(path, { pid: 4242, token: "owner-a", ts: 1, startTime: "boot-1" });
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expected metadata 缺失或当前锁无法解析时 reclaimLock 不删除", () => {
  const { dir, path } = tempLock();
  try {
    writeFileSync(path, "not-json\n");
    assert.equal(
      isRecoverableLock(path, undefined, {
        pid: 1,
        held: false,
        alive: () => true,
        startTime: () => "boot",
      }),
      false,
    );
    reclaimLock(path, undefined);
    assert.equal(existsSync(path), true);
    reclaimLock(path, { pid: 1, token: "owner", ts: 1, startTime: "boot" });
    assert.equal(existsSync(path), true);

    writeFileSync(path, "");
    reclaimLock(path, undefined);
    assert.equal(existsSync(path), true);
    reclaimLock(path, { pid: 1, token: "owner", ts: 1 });
    assert.equal(existsSync(path), true);

    writeFileSync(path, `${JSON.stringify({ token: "owner", ts: 1 })}\n`);
    assert.equal(readLockInfo(path), undefined);
    reclaimLock(path, { pid: 1, token: "owner", ts: 1 });
    assert.equal(existsSync(path), true);

    writeFileSync(path, `${JSON.stringify({ pid: 0, token: "owner", ts: 1 })}\n`);
    assert.equal(readLockInfo(path), undefined);
    reclaimLock(path, { pid: 0, token: "owner", ts: 1 });
    assert.equal(existsSync(path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("活 PID 不可按年龄回收；缺少实时启动时间同样不可回收", () => {
  const { dir, path } = tempLock();
  try {
    const info: LockInfo = { pid: 77, token: "old-owner", ts: Date.now() - 10 ** 9, startTime: "started-at-1" };
    writeLock(path, info);

    assert.equal(
      isRecoverableLock(path, info, {
        pid: 1,
        held: false,
        alive: () => true,
        startTime: () => "started-at-1",
      }),
      false,
    );

    assert.equal(
      isRecoverableLock(path, info, {
        pid: 1,
        held: false,
        alive: () => true,
        startTime: () => undefined,
      }),
      false,
    );

    assert.equal(
      isRecoverableLock(path, { pid: 77, token: "no-start", ts: Date.now() - 10 ** 9 }, {
        pid: 1,
        held: false,
        alive: () => true,
        startTime: () => "whatever",
      }),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PID 死亡或启动时间不一致仍可回收", () => {
  const { dir, path } = tempLock();
  try {
    const info: LockInfo = { pid: 77, token: "old-owner", ts: Date.now(), startTime: "started-at-1" };
    writeLock(path, info);

    assert.equal(
      isRecoverableLock(path, info, {
        pid: 1,
        held: false,
        alive: () => true,
        startTime: () => "started-at-2",
      }),
      true,
    );

    assert.equal(
      isRecoverableLock(path, info, {
        pid: 1,
        held: false,
        alive: () => false,
        startTime: () => {
          throw new Error("dead pid 不应再读取启动时间");
        },
      }),
      true,
    );

    assert.equal(
      isRecoverableLock(path, { pid: 77, token: "dead-no-start", ts: Date.now() }, {
        pid: 1,
        held: false,
        alive: () => false,
        startTime: () => {
          throw new Error("dead pid 不应再读取启动时间");
        },
      }),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("当前 PID 仅在 startTime 明确可比较时才视为本进程遗留", () => {
  const { dir, path } = tempLock();
  try {
    const selfPid = 4242;
    const leftover: LockInfo = { pid: selfPid, token: "self", ts: Date.now(), startTime: "boot-self" };
    writeLock(path, leftover);

    assert.equal(
      isRecoverableLock(path, leftover, {
        pid: selfPid,
        held: false,
        alive: () => true,
        startTime: () => "boot-self",
      }),
      true,
    );

    assert.equal(
      isRecoverableLock(path, leftover, {
        pid: selfPid,
        held: false,
        alive: () => true,
        startTime: () => "boot-other",
      }),
      true,
    );

    assert.equal(
      isRecoverableLock(path, leftover, {
        pid: selfPid,
        held: true,
        alive: () => true,
        startTime: () => "boot-self",
      }),
      false,
    );

    assert.equal(
      isRecoverableLock(path, leftover, {
        pid: selfPid,
        held: false,
        alive: () => true,
        startTime: () => undefined,
      }),
      false,
    );

    assert.equal(
      isRecoverableLock(path, { pid: selfPid, token: "self", ts: Date.now() }, {
        pid: selfPid,
        held: false,
        alive: () => true,
        startTime: () => "boot-self",
      }),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("无效锁 metadata 短超时后报错且不悄悄写入，人工清理后可写入", () => {
  const { dir, path, logPath } = tempLock();
  try {
    writeFileSync(path, "not-json\n");
    withLockTimeout("150", () => {
      assert.throws(
        () => withLogLock(logPath, () => {
          throw new Error("不应进入临界区");
        }),
        /所有者 metadata 无法验证或锁仍被持有.*本次写入未完成/,
      );
    });
    assert.equal(existsSync(path), true);

    writeFileSync(path, "");
    withLockTimeout("150", () => {
      assert.throws(
        () => withLogLock(logPath, () => "wrote"),
        /所有者 metadata 无法验证或锁仍被持有/,
      );
    });
    assert.equal(existsSync(path), true);

    writeFileSync(path, `${JSON.stringify({ pid: 12, ts: 1 })}\n`);
    withLockTimeout("150", () => {
      assert.throws(
        () => withLogLock(logPath, () => "wrote"),
        /本次写入未完成/,
      );
    });
    assert.equal(existsSync(path), true);

    rmSync(path);
    assert.equal(withLogLock(logPath, () => "ok"), "ok");
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Unix ps 启动时间强制 UTC，不受调用方时区影响", () => {
  if (process.platform === "linux" || process.platform === "win32") return;
  const previous = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    const utcStartTime = readProcessStartTimeForPlatform(process.pid, process.platform);
    process.env.TZ = "Asia/Shanghai";
    const shanghaiStartTime = readProcessStartTimeForPlatform(process.pid, process.platform);
    assert.notEqual(utcStartTime, undefined);
    assert.equal(shanghaiStartTime, utcStartTime);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("平台启动时间读取走可注入分支，不依赖切换 process.platform", () => {
  assert.equal(processStartTimeKind("linux"), "linux");
  assert.equal(processStartTimeKind("darwin"), "unix-ps");
  assert.equal(processStartTimeKind("freebsd"), "unix-ps");
  assert.equal(processStartTimeKind("openbsd"), "unix-ps");
  assert.equal(processStartTimeKind("win32"), "windows");
  assert.equal(processStartTimeKind("unknown"), undefined);

  const calls: string[] = [];
  const readers = {
    linux: (pid: number) => {
      calls.push(`linux:${pid}`);
      return "proc-start";
    },
    unixPs: (pid: number) => {
      calls.push(`ps:${pid}`);
      return "ps-start";
    },
    windows: (pid: number) => {
      calls.push(`win:${pid}`);
      return "win-start";
    },
  };

  assert.equal(readProcessStartTimeForPlatform(11, "linux", readers), "proc-start");
  assert.equal(readProcessStartTimeForPlatform(12, "darwin", readers), "ps-start");
  assert.equal(readProcessStartTimeForPlatform(13, "freebsd", readers), "ps-start");
  assert.equal(readProcessStartTimeForPlatform(14, "win32", readers), "win-start");
  assert.equal(readProcessStartTimeForPlatform(15, "unknown", readers), undefined);
  assert.equal(readProcessStartTimeForPlatform(0, "linux", readers), undefined);
  assert.equal(readProcessStartTimeForPlatform(-3, "win32", readers), undefined);
  assert.deepEqual(calls, ["linux:11", "ps:12", "ps:13", "win:14"]);

  assert.equal(readProcessStartTimeForPlatform(21, "win32", {
    windows: () => {
      throw new Error("windows 读取失败");
    },
  }), undefined);
  assert.equal(readProcessStartTimeForPlatform(22, "linux", { linux: () => undefined }), undefined);

  assert.equal(parseSpawnedStartTime({ status: 0, stdout: "  Mon Jan  1 00:00:00 2024 \n" }), "Mon Jan  1 00:00:00 2024");
  assert.equal(parseSpawnedStartTime({ status: 0, stdout: "2024-01-01T00:00:00.0000000Z" }), "2024-01-01T00:00:00.0000000Z");
  assert.equal(parseSpawnedStartTime({ status: 1, stdout: "2024-01-01T00:00:00.0000000Z" }), undefined);
  assert.equal(parseSpawnedStartTime({ status: 0, stdout: "   " }), undefined);
  assert.equal(parseSpawnedStartTime(undefined), undefined);
});
