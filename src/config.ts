import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AutoRecallMode, HistorySettings, MemorySettings, PiCompactConfig, WindowSettings } from "./types.ts";

export const DEFAULT_CONFIG: PiCompactConfig = {
  enabled: true,
  overrideDefaultCompaction: true,
  summaryMaxChars: 12000,
  autoRecall: true,
  autoRecallMode: "full",
  autoRecallMaxChars: 5000,
  recallMaxResults: 8,
  recallMaxChars: 16000,
  debug: false,
  memory: {
    enabled: true,
    pinnedInjection: true,
    proposalsProvisionalOnly: true,
    hintMaxChars: 4000,
    deriveOnCompact: true,
  },
  history: {
    autoRecallPrimaryOnly: true,
    excludeInContext: true,
  },
  window: {
    manifest: true,
  },
};

const AUTO_RECALL_MODES = new Set<AutoRecallMode>(["full", "hint", "off"]);

const configPath = (cwd: string): string => join(cwd, ".pi", "pi-compact.json");

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const booleanField = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

const positiveInteger = (value: unknown, fallback: number, maximum: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
};

const normalizeAutoRecallMode = (parsed: Record<string, unknown>): AutoRecallMode => {
  // 合法 autoRecallMode 优先；未配置时 autoRecall === false 映射为 off，否则为 full。
  if (typeof parsed.autoRecallMode === "string" && AUTO_RECALL_MODES.has(parsed.autoRecallMode as AutoRecallMode)) {
    return parsed.autoRecallMode as AutoRecallMode;
  }
  if (parsed.autoRecall === false) return "off";
  return DEFAULT_CONFIG.autoRecallMode;
};

const normalizeMemory = (parsed: Record<string, unknown>): MemorySettings => {
  const nested = asRecord(parsed.memory) ?? {};
  return {
    enabled: booleanField(nested.enabled ?? parsed.memoryEnabled, DEFAULT_CONFIG.memory.enabled),
    pinnedInjection: booleanField(nested.pinnedInjection ?? parsed.memoryPinnedInjection, DEFAULT_CONFIG.memory.pinnedInjection),
    proposalsProvisionalOnly: booleanField(
      nested.proposalsProvisionalOnly ?? parsed.memoryProposalsProvisionalOnly,
      DEFAULT_CONFIG.memory.proposalsProvisionalOnly,
    ),
    hintMaxChars: positiveInteger(nested.hintMaxChars ?? parsed.memoryHintMaxChars, DEFAULT_CONFIG.memory.hintMaxChars, 50_000),
    deriveOnCompact: booleanField(nested.deriveOnCompact ?? parsed.memoryDeriveOnCompact, DEFAULT_CONFIG.memory.deriveOnCompact),
  };
};

const normalizeHistory = (parsed: Record<string, unknown>): HistorySettings => {
  const nested = asRecord(parsed.history) ?? {};
  return {
    autoRecallPrimaryOnly: booleanField(
      nested.autoRecallPrimaryOnly ?? parsed.historyAutoRecallPrimaryOnly,
      DEFAULT_CONFIG.history.autoRecallPrimaryOnly,
    ),
    excludeInContext: booleanField(
      nested.excludeInContext ?? parsed.historyExcludeInContext,
      DEFAULT_CONFIG.history.excludeInContext,
    ),
  };
};

const normalizeWindow = (parsed: Record<string, unknown>): WindowSettings => {
  const nested = asRecord(parsed.window) ?? {};
  return {
    manifest: booleanField(nested.manifest ?? parsed.windowManifest, DEFAULT_CONFIG.window.manifest),
  };
};

const normalizeConfig = (value: unknown): PiCompactConfig => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_CONFIG;
  const parsed = value as Record<string, unknown>;
  return {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_CONFIG.enabled,
    overrideDefaultCompaction: typeof parsed.overrideDefaultCompaction === "boolean"
      ? parsed.overrideDefaultCompaction
      : DEFAULT_CONFIG.overrideDefaultCompaction,
    summaryMaxChars: positiveInteger(parsed.summaryMaxChars, DEFAULT_CONFIG.summaryMaxChars, 100_000),
    autoRecall: typeof parsed.autoRecall === "boolean" ? parsed.autoRecall : DEFAULT_CONFIG.autoRecall,
    autoRecallMode: normalizeAutoRecallMode(parsed),
    autoRecallMaxChars: positiveInteger(parsed.autoRecallMaxChars, DEFAULT_CONFIG.autoRecallMaxChars, 50_000),
    recallMaxResults: positiveInteger(parsed.recallMaxResults, DEFAULT_CONFIG.recallMaxResults, 30),
    recallMaxChars: positiveInteger(parsed.recallMaxChars, DEFAULT_CONFIG.recallMaxChars, 100_000),
    debug: typeof parsed.debug === "boolean" ? parsed.debug : DEFAULT_CONFIG.debug,
    memory: normalizeMemory(parsed),
    history: normalizeHistory(parsed),
    window: normalizeWindow(parsed),
  };
};

export const loadConfig = (cwd: string): PiCompactConfig => {
  const paths = [configPath(cwd), join(homedir(), ".pi", "agent", "pi-compact.json")];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return DEFAULT_CONFIG;
    }
  }
  return DEFAULT_CONFIG;
};

export const scaffoldConfig = (cwd: string): void => {
  const path = configPath(cwd);
  const globalPath = join(homedir(), ".pi", "agent", "pi-compact.json");
  if (existsSync(path) || existsSync(globalPath)) return;
  try {
    const directory = join(cwd, ".pi");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: "wx" });
  } catch {
    // 配置文件是可选的，权限问题不应阻止扩展加载。
  }
};
