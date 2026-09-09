import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scaffoldConfig } from "./src/config.ts";
import { registerHooks } from "./src/hooks.ts";
import { registerMemory } from "./src/memory.ts";
import { registerRecall } from "./src/recall.ts";
import { ensureStore } from "./src/core/store.ts";

export default function piCompact(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    scaffoldConfig(ctx.cwd);
    ensureStore(ctx.cwd);
  });
  registerHooks(pi);
  registerRecall(pi);
  registerMemory(pi);
}
