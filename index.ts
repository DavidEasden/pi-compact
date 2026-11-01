import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scaffoldConfig } from "./src/config.ts";
import { registerHooks } from "./src/hooks.ts";
import { registerMemory } from "./src/memory.ts";
import { registerRecall } from "./src/recall.ts";
import { registerStatus } from "./src/status.ts";
import { ensureStore } from "./src/core/store.ts";

export default function piCompact(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    scaffoldConfig(ctx.cwd);
    // 只读工作区无法创建 store 时不应阻止扩展加载；后续写入会给出明确错误。
    try {
      ensureStore(ctx.cwd);
    } catch {
      // 忽略目录创建失败。
    }
  });
  registerHooks(pi);
  registerRecall(pi);
  registerMemory(pi);
  registerStatus(pi);
}
