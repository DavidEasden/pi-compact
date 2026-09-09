import type { CompactReason, HistoryRecord, WindowManifest } from "../types.ts";
import { appendWindowEvent, newWindowId, readWindowEvents } from "./store.ts";

export const parentWindowForSession = (cwd: string, sessionId?: string) => {
  const events = readWindowEvents(cwd);
  if (events.length === 0) return undefined;
  const sameSession = sessionId ? events.filter((event) => event.sessionId === sessionId) : [];
  return (sameSession.length > 0 ? sameSession : events).at(-1);
};

export const buildWindowManifest = (input: {
  cwd: string;
  records: HistoryRecord[];
  sourceHash: string;
  keptEntryId: string;
  reason: CompactReason;
  isSplitTurn: boolean;
  sessionId?: string;
  createdAt?: string;
}): WindowManifest => {
  const parent = parentWindowForSession(input.cwd, input.sessionId);
  const sourceEntryIds = [...new Set(input.records.map((record) => record.entryId))];
  const seq = (readWindowEvents(input.cwd).at(-1)?.seq ?? 0) + 1;
  return {
    windowId: newWindowId(input.sourceHash, seq),
    parentWindowId: parent?.windowId,
    keptEntryId: input.keptEntryId,
    sourceCount: sourceEntryIds.length,
    sourceHash: input.sourceHash,
    previousHash: parent?.hash ?? "",
    sourceEntryIds,
    reason: input.reason,
    isSplitTurn: input.isSplitTurn,
    firstSourceEntryId: input.records[0]?.entryId,
    lastSourceEntryId: input.records.at(-1)?.entryId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    sessionId: input.sessionId,
  };
};

export const persistWindowManifest = (cwd: string, manifest: WindowManifest) => appendWindowEvent(cwd, manifest);

export const windowHeaderLines = (manifest: WindowManifest): string[] => [
  `windowId: ${manifest.windowId}`,
  `parentWindowId: ${manifest.parentWindowId ?? "none"}`,
  `sourceCount: ${manifest.sourceCount}`,
  `sourceHash: ${manifest.sourceHash}`,
  `previousHash: ${manifest.previousHash || "genesis"}`,
];
