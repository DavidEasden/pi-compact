import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PiCompactConfig } from "./types.ts";

export const DEFAULT_CONFIG: PiCompactConfig = {
  enabled: true,
  overrideDefaultCompaction: true,
  summaryMaxChars: 12000,
  autoRecall: true,
  autoRecallMaxChars: 5000,
  recallMaxResults: 8,
  recallMaxChars: 16000,
  debug: false,
};

const configPath = (cwd: string): string => join(cwd, ".pi", "pi-compact.json");

const positiveInteger = (value: unknown, fallback: number, maximum: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
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
    autoRecallMaxChars: positiveInteger(parsed.autoRecallMaxChars, DEFAULT_CONFIG.autoRecallMaxChars, 50_000),
    recallMaxResults: positiveInteger(parsed.recallMaxResults, DEFAULT_CONFIG.recallMaxResults, 30),
    recallMaxChars: positiveInteger(parsed.recallMaxChars, DEFAULT_CONFIG.recallMaxChars, 100_000),
    debug: typeof parsed.debug === "boolean" ? parsed.debug : DEFAULT_CONFIG.debug,
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
