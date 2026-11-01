export interface InjectionStats {
  hits: number;
  misses: number;
  lastChars: number;
  lastTokens: number;
  lastAt?: string;
}

export interface CompactStats {
  lastReason?: string;
  /** 提交阶段耗时（窗口/摘要/派生写入），不含 Pi 的准备阶段。 */
  lastDurationMs?: number;
  lastRecords?: number;
  lastCheckpointChars?: number;
  lastDerivedCreated?: number;
  lastAt?: string;
}

export interface RuntimeStats {
  injection: InjectionStats;
  compact: CompactStats;
}

export const runtimeStats: RuntimeStats = {
  injection: { hits: 0, misses: 0, lastChars: 0, lastTokens: 0 },
  compact: {},
};

/** 仅供测试和诊断重置；生产路径只增量更新。 */
export const resetRuntimeStats = (): void => {
  runtimeStats.injection = { hits: 0, misses: 0, lastChars: 0, lastTokens: 0 };
  runtimeStats.compact = {};
};
