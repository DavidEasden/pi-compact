import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const registerCompactCommand = (pi: ExtensionAPI): void => {
  pi.registerCommand("pi-compact", {
    description: "立即使用 pi-compact 的确定性算法压缩当前 session",
    handler: async (_args: string, ctx: any) => {
      ctx.compact({
        customInstructions: "pi-compact deterministic compaction",
        onComplete: () => ctx.ui.notify("pi-compact: 压缩完成", "info"),
        onError: (error: Error) => ctx.ui.notify(`pi-compact: 压缩失败：${error.message}`, "error"),
      });
    },
  });
};
