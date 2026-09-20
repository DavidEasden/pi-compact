import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const RESUME_CONTEXT_TYPE = "pi-compact-resume";

interface WindowRequest {
  sessionId: string;
  callIds: Set<string>;
  signal?: AbortSignal;
  phase: "queued" | "compacting";
}

/** 工具先登记；同批调用全部落盘后才换窗，完成回调再续接任务。 */
export const registerNewContext = (pi: ExtensionAPI): void => {
  let pending: WindowRequest | undefined;
  const clear = () => { pending = undefined; };
  const sameSession = (request: WindowRequest, ctx: ExtensionContext): boolean => (
    pending === request && ctx.sessionManager.getSessionId() === request.sessionId
  );

  const compact = (request: WindowRequest, ctx: ExtensionContext, resume: boolean): void => {
    request.phase = "compacting";
    const failed = () => {
      if (pending !== request) return;
      clear();
      ctx.ui?.notify?.("pi-compact: 新窗口压缩失败或已取消，未自动续跑。请使用 /compact 重试。", "warning");
    };
    try {
      // 不等待回调：手动压缩内部先等待 Agent 停止，在 turn_end 中等待它会死锁。
      ctx.compact({
        onComplete: () => {
          if (!sameSession(request, ctx)) return;
          clear();
          // 用户已有新输入或其他扩展已经开始工作时，不再额外提交续跑请求。
          if (!resume || !ctx.isIdle() || ctx.hasPendingMessages()) return;
          pi.sendMessage({
            customType: RESUME_CONTEXT_TYPE,
            content: "上下文压缩已完成。请继续当前尚未完成的任务；需要核对历史原文时使用 pi_compact_recall。",
            display: false,
          }, { triggerTurn: true });
        },
        onError: failed,
      });
    } catch {
      failed();
    }
  };

  pi.on("turn_end", (event, ctx) => {
    const request = pending;
    if (!request || request.phase !== "queued") return;
    if (!sameSession(request, ctx) || request.signal?.aborted || ctx.signal?.aborted || ctx.hasPendingMessages()) {
      clear();
      return;
    }
    // 只消费真正返回成功结果的换窗调用，且此时所有兄弟工具都已完成并持久化。
    if (!event.toolResults.some((result) => request.callIds.has(result.toolCallId) && !result.isError)) return;
    compact(request, ctx, true);
  });

  pi.on("input", (event) => {
    if (event.source !== "extension") clear();
    return { action: "continue" };
  });
  pi.on("session_before_switch", clear);
  pi.on("session_before_fork", clear);
  pi.on("session_before_tree", clear);
  pi.on("session_shutdown", clear);
  pi.on("session_compact_failed", clear);

  pi.registerTool({
    name: "pi_compact_new_context",
    label: "Request a new context window",
    description: "请求在本轮工具全部完成后开启新上下文窗口，压缩成功后继续当前任务。原始 session 保留；失败或用户取消时不自动续跑。",
    promptSnippet: "请求本轮工具完成后压缩并继续当前任务",
    promptGuidelines: ["需要新窗口时调用 pi_compact_new_context；它会在本轮工具完成后压缩并续跑，不要把 checkpoint 当成长期记忆。"],
    parameters: Type.Object({}),
    async execute(toolCallId, _input, signal, _onUpdate, ctx) {
      if (typeof ctx.compact !== "function" || typeof ctx.sessionManager?.getSessionId !== "function") {
        return {
          content: [{ type: "text", text: "当前扩展上下文不支持安全换窗。请使用 Pi 原生 /compact。" }],
          details: { requested: false, degraded: true },
        };
      }
      if (signal?.aborted || ctx.signal?.aborted) {
        return { content: [{ type: "text", text: "当前任务已取消，未申请新窗口。" }], details: { requested: false, degraded: false } };
      }
      const sessionId = ctx.sessionManager.getSessionId();
      if (!pending || pending.sessionId !== sessionId) {
        pending = { sessionId, callIds: new Set(), signal, phase: "queued" };
      }
      pending.callIds.add(toolCallId);
      if (ctx.isIdle?.() && pending.phase === "queued") compact(pending, ctx, false);
      return {
        content: [{ type: "text", text: "已登记换窗请求；本轮工具全部完成后执行压缩，成功后继续当前任务。当前尚未确认压缩完成。" }],
        details: { requested: true, deferred: true, degraded: false },
      };
    },
  });
};
