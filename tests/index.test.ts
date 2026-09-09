import assert from "node:assert/strict";
import test from "node:test";
import piCompact from "../index.ts";

test("入口使用 Pi 原生 /compact，不注册独立的压缩命令", () => {
  const commands: string[] = [];
  const tools: string[] = [];
  const pi = {
    on() {},
    registerTool(definition: { name: string }) {
      tools.push(definition.name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
  };

  piCompact(pi as any);

  assert.deepEqual(commands, ["pi-compact-recall", "remember", "memories", "forget"]);
  assert.deepEqual(tools, [
    "pi_compact_recall",
    "pi_memory_search",
    "pi_memory_read",
    "pi_memory_propose",
    "pi_memory_update",
    "pi_compact_new_context",
  ]);
});
