import type { MemoryPriority, MemoryRecord } from "../types.ts";

export const MEMORY_HINT_TYPE = "pi-compact-memory-hint";

const PRIORITY_RANK: Record<MemoryPriority, number> = { high: 0, normal: 1, low: 2 };

const byWorkingOrder = (left: MemoryRecord, right: MemoryRecord): number => (
  PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]
  || left.createdAt.localeCompare(right.createdAt)
  || left.id.localeCompare(right.id)
);

const clipLine = (line: string, maxChars: number): string => {
  if (line.length <= maxChars) return line;
  return `${line.slice(0, Math.max(0, maxChars - 1))}…`;
};

const formatRecord = (record: MemoryRecord, maxContent: number): string => {
  const content = clipLine(record.content.replace(/\s+/g, " ").trim(), maxContent);
  return `- [${record.id}] ${record.kind} prio=${record.priority} ${content}`;
};

export interface WorkingHint {
  content: string;
  pinnedIds: string[];
  activeIds: string[];
  truncated: boolean;
}

/**
 * 生成确定性工作记忆提示。pinned 优先占用预算，不会被 active 条目挤掉。
 */
export const renderWorkingHint = (records: MemoryRecord[], maxChars: number): WorkingHint => {
  const pinned = records.filter((record) => record.status === "pinned" || record.pinned).sort(byWorkingOrder);
  const active = records.filter((record) => record.status === "active" && !record.pinned).sort(byWorkingOrder);
  const header = [
    "[pi-compact 工作记忆]",
    "以下为权威长期记忆，不是 LLM 摘要，也不是压缩 checkpoint。用户写入是权威来源；模型提议在用户确认前保持 provisional，不会自动变成 active/pinned。不能保证模型一定遵守这些记忆。",
    "查询记忆：pi_memory_search、pi_memory_read。查询历史原文：pi_compact_recall。保存：/remember。列表：/memories。删除：/forget。申请新窗口：pi_compact_new_context 或 Pi 原生 /compact。",
    pinned.length === 0 ? "当前没有 pinned 记忆。需要在多次压缩后仍保留的事实，请使用 /remember。" : "",
  ].filter(Boolean).join("\n");

  const budget = Math.max(0, maxChars);
  if (budget === 0) return { content: "", pinnedIds: pinned.map((record) => record.id), activeIds: [], truncated: true };

  const lines: string[] = [header];
  let truncated = header.length > budget;
  const remainingAfterHeader = Math.max(0, budget - Math.min(header.length, budget));
  const pinnedCap = pinned.length === 0 ? 0 : Math.max(48, Math.floor(remainingAfterHeader / pinned.length) - 24);

  if (pinned.length > 0) {
    lines.push("已固定（pinned，优先且不可被普通召回挤掉）：");
    for (const record of pinned) lines.push(formatRecord(record, Math.max(24, pinnedCap)));
  }

  let assembled = lines.join("\n");
  if (assembled.length > budget) {
    // 预算不足时仍尽量保留每条 pinned 的 ID 行。
    const compact = [clipLine(header, Math.max(80, Math.floor(budget * 0.35))), "已固定（pinned，优先且不可被普通召回挤掉）："];
    const idBudget = Math.max(24, Math.floor((budget - compact.join("\n").length) / Math.max(pinned.length, 1)));
    for (const record of pinned) compact.push(clipLine(formatRecord(record, Math.max(12, idBudget - 32)), Math.max(24, idBudget)));
    assembled = clipLine(compact.join("\n"), budget);
    return { content: assembled, pinnedIds: pinned.map((record) => record.id), activeIds: [], truncated: true };
  }

  const activeLines: string[] = [];
  if (active.length > 0) {
    activeLines.push("活动（active）：");
    const leftover = budget - assembled.length - 1;
    const per = Math.max(32, Math.floor(leftover / active.length) - 16);
    for (const record of active) {
      const line = formatRecord(record, per);
      const candidate = [...lines, ...activeLines, line].join("\n");
      if (candidate.length > budget) {
        truncated = true;
        break;
      }
      activeLines.push(line);
    }
    if (activeLines.length > 1) lines.push(...activeLines);
    else if (active.length > 0) truncated = true;
  }

  assembled = lines.join("\n");
  if (assembled.length > budget) {
    assembled = clipLine(assembled, budget);
    truncated = true;
  }
  return {
    content: assembled,
    pinnedIds: pinned.map((record) => record.id),
    activeIds: active.slice(0, Math.max(0, activeLines.length - 1)).map((record) => record.id),
    truncated,
  };
};
