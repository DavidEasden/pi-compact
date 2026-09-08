import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PiCompactConfig } from "./types.ts";

export const DEFAULT_CONFIG: PiCompactConfig = {
  enabled: true,
  overrideDefaultCompaction: true,
  keepRecentTokens: 20000,
  summaryMaxChars: 12000,
  recentUserTurns: 1,
  autoRecall: true,
  autoRecallMaxChars: 5000,
  recallMaxResults: 8,
  debug: false,
};

const configPath = (cwd: string): string => join(cwd, ".pi", "pi-compact.json");

export const loadConfig = (cwd: string): PiCompactConfig => {
  const paths = [configPath(cwd), join(homedir(), ".pi", "agent", "pi-compact.json")];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PiCompactConfig>;
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      return DEFAULT_CONFIG;
    }
  }
  return DEFAULT_CONFIG;
};

export const scaffoldConfig = (cwd: string): void => {
  const path = configPath(cwd);
  if (existsSync(path)) return;
  try {
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: "wx" });
  } catch {
    // 配置文件是可选的，权限问题不应阻止扩展加载。
  }
};
