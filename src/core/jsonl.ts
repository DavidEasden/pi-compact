import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");

/** 规范化对象后再哈希，避免键插入顺序破坏链式校验。 */
export const stableHash = (value: unknown): string => hashText(JSON.stringify(stableValue(value)));

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = stableValue((value as Record<string, unknown>)[key]);
  }
  return output;
};

export const ensureDir = (directory: string): void => {
  mkdirSync(directory, { recursive: true });
};

const endsWithNewline = (path: string): boolean => {
  if (!existsSync(path)) return true;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 10;
  } finally {
    closeSync(fd);
  }
};

/** 追加前若存在半行，先补换行，避免新行与损坏尾部粘连。 */
const sealPartialLine = (path: string): void => {
  if (!existsSync(path) || endsWithNewline(path)) return;
  appendFileSync(path, "\n");
};

export const readJsonl = (path: string): unknown[] => {
  if (!existsSync(path)) return [];
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // 半行或损坏行：安全跳过，不让整份日志失效。
    }
  }
  return rows;
};

export const appendJsonl = (path: string, value: unknown): void => {
  ensureDir(dirname(path));
  sealPartialLine(path);
  appendFileSync(path, `${JSON.stringify(value)}\n`);
};
