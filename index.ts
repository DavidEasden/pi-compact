import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scaffoldConfig } from "./src/config.ts";
import { registerHooks } from "./src/hooks.ts";
import { registerRecall } from "./src/recall.ts";

export default function piCompact(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    scaffoldConfig(ctx.cwd);
  });
  registerHooks(pi);
  registerRecall(pi);
}
