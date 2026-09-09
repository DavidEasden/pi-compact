/**
 * 自动历史召回的确定性门控：规范化、停用词/停用短语过滤、最小有效词门槛与匹配信号分级。
 * 不使用 LLM、embedding 或网络。手动 pi_compact_recall 不走此门控。
 */

export type AutoRecallSignal = "path" | "error-code" | "identifier" | "command" | "multi-term" | "cjk-topic";

export interface AutoRecallAnalysis {
  /** 是否允许自动召回检索与注入。 */
  eligible: boolean;
  /** 供 searchRecords 原样使用的检索词（已小写）；有强信号时只含强信号词。 */
  terms: string[];
  /** 命中的匹配信号，便于解释为何放行。 */
  signals: AutoRecallSignal[];
}

/** 整句会话控制 / 礼貌用语；规范化后整句匹配即拒绝自动召回。 */
const STOP_PHRASES = new Set([
  "continue",
  "please continue",
  "continue please",
  "go on",
  "go ahead",
  "keep going",
  "keep on",
  "proceed",
  "ok",
  "okay",
  "okey",
  "yes",
  "yeah",
  "yep",
  "yup",
  "no",
  "nope",
  "nah",
  "thanks",
  "thank you",
  "thx",
  "ty",
  "please",
  "please do",
  "sure",
  "got it",
  "sounds good",
  "looks good",
  "cool",
  "nice",
  "great",
  "good",
  "fine",
  "try again",
  "please retry",
  "retry",
  "once more",
  "again",
  "next",
  "next step",
  "previous",
  "go back",
  "hello",
  "hi",
  "hey",
  "yo",
  "wait",
  "stop",
  "never mind",
  "nvm",
  "same",
  "ditto",
  "继续",
  "请继续",
  "继续吧",
  "接着",
  "接着来",
  "往下",
  "往下说",
  "好",
  "好的",
  "好吧",
  "行",
  "可以",
  "嗯",
  "哦",
  "啊",
  "噢",
  "谢谢",
  "感谢",
  "多谢",
  "好的谢谢",
  "上一步",
  "下一步",
  "再试",
  "再试一次",
  "请再试一次",
  "重试",
  "再来一次",
  "收到",
  "明白",
  "了解",
  "知道了",
  "帮我继续",
  "look at this",
  "what is it",
  "how to",
  "帮我看看",
]);

/** 分词后的泛词；单独或全为这类词时不能触发自动召回。 */
const STOP_TOKENS = new Set([
  "ok",
  "okay",
  "okey",
  "yes",
  "yeah",
  "yep",
  "yup",
  "no",
  "nope",
  "nah",
  "please",
  "thanks",
  "thank",
  "thx",
  "ty",
  "continue",
  "go",
  "going",
  "ahead",
  "on",
  "next",
  "prev",
  "previous",
  "retry",
  "again",
  "try",
  "more",
  "once",
  "sure",
  "right",
  "got",
  "it",
  "this",
  "that",
  "with",
  "from",
  "the",
  "and",
  "just",
  "then",
  "now",
  "well",
  "good",
  "great",
  "fine",
  "cool",
  "nice",
  "proceed",
  "keep",
  "stop",
  "wait",
  "hello",
  "hi",
  "hey",
  "yo",
  "sorry",
  "help",
  "do",
  "same",
  "ditto",
  "nvm",
  "never",
  "mind",
  "looks",
  "sounds",
  "back",
  "step",
  "steps",
  "done",
  "skip",
  "resume",
  "onward",
  "hmm",
  "huh",
  "ah",
  "oh",
  "wow",
  "please",
  "继续",
  "请继续",
  "好的",
  "谢谢",
  "感谢",
  "多谢",
  "上一步",
  "下一步",
  "再试",
  "再试一次",
  "重试",
  "可以",
  "好吧",
  "接着",
  "往下",
  "同上",
  "一样",
  "还是",
  "一步",
  "一下",
  "一次",
  "收到",
  "明白",
  "了解",
  "知道",
  "拜托",
  "麻烦",
  "之前",
  "之后",
  "这个",
  "那个",
  "然后",
  "需要",
  // 英文功能词 / 疑问词 / 请求动词，避免 look at this、what is it 凭泛词过门。
  "at",
  "is",
  "be",
  "to",
  "of",
  "or",
  "if",
  "we",
  "you",
  "me",
  "so",
  "what",
  "why",
  "how",
  "who",
  "where",
  "when",
  "which",
  "whom",
  "whose",
  "look",
  "see",
  "check",
  "tell",
  "show",
  "ask",
  "say",
  "make",
  "can",
  "could",
  "would",
  "should",
  "will",
  "may",
  "might",
  "must",
  "for",
  "are",
  "was",
  "were",
  "am",
  "an",
  "as",
  "by",
  "in",
  "into",
  "about",
  "not",
  "but",
  "than",
  "too",
  "very",
  "also",
  "really",
  "my",
  "your",
  "our",
  "their",
  "his",
  "her",
  "its",
  "they",
  "them",
  "he",
  "she",
  "us",
  "him",
  "let",
  "get",
  "have",
  "has",
  "had",
  "does",
  "did",
  "doing",
  "use",
  "used",
  "using",
  "like",
  "some",
  "any",
  "all",
  "these",
  "those",
  "here",
  "there",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "thing",
  "things",
  // 中文会话 / 疑问 / 请求词；弱中文词不得单独过门或覆盖真正内容词。
  "帮我",
  "帮忙",
  "看看",
  "看一下",
  "帮",
  "请",
  "请问",
  "为什么",
  "什么",
  "怎么",
  "怎么样",
  "怎样",
  "如何",
  "为何",
  "干什么",
  "哪里",
  "哪儿",
  "哪个",
  "哪些",
  "谁",
  "多少",
  "什么样",
  "是不是",
  "有没有",
  "能不能",
  "可不可以",
  "行不行",
  "好不好",
  "是否",
  "难道",
  "问题",
  "不知道",
  "无所谓",
  "因为",
  "所以",
  "如果",
  "虽然",
  "但是",
  "到底",
  "其实",
]);

const COMMAND_NAMES = "npm|npx|pnpm|yarn|git|cargo|make|docker|kubectl|pytest|curl|wget|node|tsc|eslint";

/** 易被路径/扩展名正则误伤的缩写与并列词，不得作为 path 强信号。 */
const PATH_FALSE_POSITIVES = new Set(["e.g", "i.e", "u.s", "a.m", "p.m", "and/or", "yes/no", "y/n", "n/a", "on/off"]);

const isPathFalsePositive = (value: string): boolean => PATH_FALSE_POSITIVES.has(value.toLocaleLowerCase());

const commandArgOf = (value: string): string => value.trim().split(/\s+/).slice(1).join(" ").toLocaleLowerCase();

/** make sure 这类动词短语不得当成命令；npm test / git diff 仍保留。 */
const isFillerCommand = (value: string): boolean => {
  const arg = commandArgOf(value);
  return !arg || STOP_TOKENS.has(arg) || STOP_PHRASES.has(arg);
};

const unique = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
};

const isCjkToken = (token: string): boolean => /^[\p{Script=Han}]+$/u.test(token);

/** 规范化：兼容全角、折叠空白、去掉首尾标点，便于整句停用短语匹配。 */
export const normalizeAutoRecallQuery = (query: string): string => query
  .normalize("NFKC")
  .replace(/[^\p{L}\p{N}_.\-/\\ ]+/gu, " ")
  .replace(/\s+/g, " ")
  .trim()
  .toLocaleLowerCase();

const rawTokens = (text: string): string[] => {
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh", { granularity: "word" }) : undefined;
  const chunks = segmenter ? [...segmenter.segment(text)].map((item) => item.segment) : text.split(/\s+/);
  return [...new Set(chunks.flatMap((chunk) => chunk.split(/[^\p{L}\p{N}_.\-/]+/u).filter((token) => token.length >= 2)))];
};

const collectMatches = (text: string, pattern: RegExp): string[] => {
  const flags = pattern.global ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))]
    .map((match) => match[0]?.trim() ?? "")
    .filter((value) => value.length >= 2);
};

const classifyToken = (raw: string): AutoRecallSignal | undefined => {
  if (isPathFalsePositive(raw)) return undefined;
  if (/[\\/]/.test(raw) || (/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(raw) && !/^\d+\.\d+$/.test(raw))) return "path";
  // 错误码必须大小写敏感，避免 end/email/error/ab12 被当成 E* / ABC-123 形式。
  if (/^E[A-Z]{2,}$/.test(raw) || /^ERR_[A-Z0-9_]+$/.test(raw) || /^[A-Z]{2,}-\d+$/.test(raw) || /^[A-Z]{2,}\d{2,}$/.test(raw)) {
    return "error-code";
  }
  if (/[a-z][A-Z]/.test(raw) || /[A-Z]{2,}[a-z]/.test(raw) || /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+$/.test(raw)) return "identifier";
  if (/[A-Za-z]/.test(raw) && /\d/.test(raw) && raw.length >= 4) return "identifier";
  if (isCjkToken(raw) && raw.length >= 3) return "cjk-topic";
  return undefined;
};

const extractStrongTerms = (query: string): { terms: string[]; signals: AutoRecallSignal[] } => {
  const terms: string[] = [];
  const signals = new Set<AutoRecallSignal>();
  const add = (values: string[], signal: AutoRecallSignal): void => {
    for (const value of values) {
      const lower = value.toLocaleLowerCase();
      if (lower.length < 2 || STOP_TOKENS.has(lower) || STOP_PHRASES.has(lower)) continue;
      if (signal === "path" && isPathFalsePositive(lower)) continue;
      if (signal === "command" && isFillerCommand(value)) continue;
      terms.push(lower);
      signals.add(signal);
    }
  };
  add(collectMatches(query, /(?:[\w.~-]+)?(?:\/[\w.-]+)+/g), "path");
  add(collectMatches(query, /[A-Za-z]:\\(?:[\w.-]+\\)+[\w.-]+/g), "path");
  add(collectMatches(query, /\b[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g), "path");
  add(collectMatches(query, /\bE[A-Z]{2,}\b/g), "error-code");
  add(collectMatches(query, /\bERR_[A-Z0-9_]+\b/g), "error-code");
  add(collectMatches(query, /\b[A-Z]{2,}-\d+\b/g), "error-code");
  add(collectMatches(query, /\b[A-Z]{2,}\d{2,}\b/g), "error-code");
  add(collectMatches(query, /\b(?:exit|status|errno)\s+\d+\b/gi), "error-code");
  add(collectMatches(query, /\bHTTP\/?\d*(?:\.\d+)?\s*[45]\d{2}\b/gi), "error-code");
  add(collectMatches(query, /\b[A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g), "identifier");
  add(collectMatches(query, /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g), "identifier");
  add(collectMatches(query, new RegExp(`\\b(?:${COMMAND_NAMES})\\s+\\S+`, "gi")), "command");
  add(collectMatches(query, /`([A-Za-z_][\w.]*)`/g).map((value) => value.replace(/`/g, "")), "identifier");
  return { terms: unique(terms), signals: [...signals] };
};

export const analyzeAutoRecallQuery = (query: string): AutoRecallAnalysis => {
  const normalized = normalizeAutoRecallQuery(query);
  if (!normalized || STOP_PHRASES.has(normalized)) {
    return { eligible: false, terms: [], signals: [] };
  }

  const extracted = extractStrongTerms(query);
  const strong = new Set(extracted.terms);
  const signals = new Set<AutoRecallSignal>(extracted.signals);
  const content: string[] = [];

  for (const token of rawTokens(query)) {
    const lower = token.toLocaleLowerCase();
    if (STOP_TOKENS.has(lower) || STOP_PHRASES.has(lower) || isPathFalsePositive(lower)) continue;
    const signal = classifyToken(token);
    if (signal === "cjk-topic") {
      // 弱中文主题只参与多词门槛，不覆盖 token/路径等其他内容词。
      signals.add(signal);
      content.push(lower);
      continue;
    }
    if (signal) {
      strong.add(lower);
      signals.add(signal);
      continue;
    }
    // 拉丁内容词至少 3 个字符，避免 at/is/to 这类功能词凑成 multi-term。
    if (!isCjkToken(token) && lower.length < 3) continue;
    content.push(lower);
  }

  const strongTerms = unique([...strong]);
  const contentTerms = unique(content.filter((term) => !strong.has(term)));
  if (contentTerms.length >= 2) signals.add("multi-term");

  // 有路径/错误码/标识符/命令等强信号时只用这些词检索，避免「继续」等泛词搭车命中。
  const terms = strongTerms.length > 0 ? strongTerms : contentTerms;
  const eligible = strongTerms.length > 0 || contentTerms.length >= 2;
  if (!eligible || terms.length === 0) return { eligible: false, terms: [], signals: [] };
  return { eligible: true, terms, signals: [...signals] };
};
