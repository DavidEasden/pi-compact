import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isRecoverableLock, readLockInfo, reclaimLock, type LockInfo } from "../src/core/lock.ts";

const tempLock = (): { dir: string; path: string } => {
  const dir = mkdtempSync(join(tmpdir(), "pi-compact-lock-"));
  return { dir, path: join(dir, "memory.jsonl.lock") };
};

const writeLock = (path: string, info: LockInfo): void => {
  writeFileSync(path, `${JSON.stringify(info)}\n`);
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

test("PID 仍存活但启动时间不同视为复用，可以回收；读不到启动时间则保守不回收", () => {
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
        ageMs: 0,
        staleMs: 10_000,
      }),
      true,
    );

    assert.equal(
      isRecoverableLock(path, info, {
        pid: 1,
        held: false,
        alive: () => true,
        startTime: () => undefined,
        ageMs: 0,
        staleMs: 10_000,
      }),
      false,
    );

    assert.equal(
      isRecoverableLock(path, info, {
        pid: 1,
        held: false,
        alive: () => true,
        startTime: () => "started-at-1",
        ageMs: 0,
        staleMs: 10_000,
      }),
      false,
    );

    assert.equal(
      isRecoverableLock(path, { pid: 77, token: "no-start", ts: Date.now() }, {
        pid: 1,
        held: false,
        alive: () => true,
        startTime: () => "whatever",
        ageMs: 0,
        staleMs: 10_000,
      }),
      false,
    );

    assert.equal(
      isRecoverableLock(path, info, {
        pid: 1,
        held: false,
        alive: () => false,
        startTime: () => {
          throw new Error("dead pid 不应再读取启动时间");
        },
        ageMs: 0,
        staleMs: 10_000,
      }),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
