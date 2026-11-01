import { statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { readJsonl } from "./core/jsonl.ts";
import { runtimeStats } from "./core/runtime-stats.ts";
import { memoryLogPath, readMemoryEvents, readWindowEvents, windowLogPath } from "./core/store.ts";
import { readSessionSummaryEvents, sessionSummaryLogPath } from "./core/summary.ts";

const fileSize = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

const formatBytes = (bytes: number): string => (
  bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}K` : `${(bytes / 1024 / 1024).toFixed(1)}M`
);

/** 只读诊断命令：显示日志规模、可信前缀、注入/压缩统计，不触发模型 turn。 */
export const registerStatus = (pi: ExtensionAPI): void => {
  pi.registerCommand("pi-compact-status", {
    description: "显示 pi-compact 运行时、日志和缓存统计（只读）",
    handler: async (_args: string, ctx: any) => {
      const config = loadConfig(ctx.cwd);
      const sessionId = (() => {
        try {
          const id = ctx.sessionManager?.getSessionId?.();
          return typeof id === "string" && id.length > 0 ? id : undefined;
        } catch {
          return undefined;
        }
      })();
      const branch = (() => {
        try {
          return ctx.sessionManager?.getBranch?.() ?? [];
        } catch {
          return [];
        }
      })();
      const compactionIds = branch
        .filter((entry: any) => entry.type === "compaction" && entry.details?.compactor === "pi-compact")
        .map((entry: any) => entry.id)
        .filter((id: unknown): id is string => typeof id === "string");
      const summaryPath = sessionId ? sessionSummaryLogPath(ctx.cwd, sessionId) : undefined;
      const summaryEvents = sessionId ? readSessionSummaryEvents(ctx.cwd, sessionId) : [];
      const summaryById = new Map(summaryEvents.map((event) => [event.compactionEntryId, event]));
      const currentSummary = [...compactionIds].reverse().map((id) => summaryById.get(id)).find((event) => event !== undefined);

      const memoryPath = memoryLogPath(ctx.cwd);
      const windowPath = windowLogPath(ctx.cwd);
      const memoryEvents = readMemoryEvents(ctx.cwd);
      const windowEvents = readWindowEvents(ctx.cwd);
      const memoryRows = readJsonl(memoryPath).length;
      const windowRows = readJsonl(windowPath).length;

      const text = [
        "pi-compact status",
        `enabled=${config.enabled} memory=${config.memory.enabled} summary=${config.sessionSummary.enabled} debug=${config.debug}`,
        `memory: events=${memoryEvents.length}/${memoryRows} bytes=${formatBytes(fileSize(memoryPath))}`,
        `windows: events=${windowEvents.length}/${windowRows} bytes=${formatBytes(fileSize(windowPath))}`,
        `summary: session=${sessionId ? "yes" : "none"} events=${summaryEvents.length} evidence=${currentSummary?.evidence.length ?? 0} bytes=${formatBytes(summaryPath ? fileSize(summaryPath) : 0)}`,
        `injection(process): hits=${runtimeStats.injection.hits} misses=${runtimeStats.injection.misses} lastChars=${runtimeStats.injection.lastChars} lastTokens=${runtimeStats.injection.lastTokens} lastAt=${runtimeStats.injection.lastAt ?? "never"}`,
        `compact(process): reason=${runtimeStats.compact.lastReason ?? "none"} commitMs=${runtimeStats.compact.lastDurationMs ?? "-"} records=${runtimeStats.compact.lastRecords ?? "-"} checkpointChars=${runtimeStats.compact.lastCheckpointChars ?? "-"} derivedCreated=${runtimeStats.compact.lastDerivedCreated ?? "-"} lastAt=${runtimeStats.compact.lastAt ?? "never"}`,
      ].join("\n");
      ctx.ui?.notify?.(text, "info");
    },
  });
};
