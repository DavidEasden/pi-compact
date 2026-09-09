import assert from "node:assert/strict";
import test from "node:test";
import piCompact from "../index.ts";

test("入口使用 Pi 原生 /compact，不注册独立的压缩命令", () => {
  const commands: string[] = [];
  const pi = {
    on() {},
    registerTool() {},
    registerCommand(name: string) {
      commands.push(name);
    },
  };

  piCompact(pi as any);

  assert.deepEqual(commands, ["pi-compact-recall"]);
});
