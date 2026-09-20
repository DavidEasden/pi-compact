import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, createEventBus } from "@earendil-works/pi-coding-agent";

const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
// SDK 的 pi-ai 可能被 npm 嵌套安装；确保 provider 与宿主使用同一实例。
const aiRoot = createRequire(sdkEntry).resolve.paths("@earendil-works/pi-ai")
  .map((path) => join(path, "@earendil-works/pi-ai")).find((path) => existsSync(join(path, "package.json")));
assert.ok(aiRoot);
const ai = await import(pathToFileURL(join(aiRoot, "dist/index.js")).href);
const { loadExtensions, loadExtensionFromFactory } = await import(new URL("./core/extensions/loader.js", sdkEntry));
const { estimateTokens } = await import(new URL("./core/compaction/index.js", sdkEntry));
export { estimateTokens, SessionManager };
export const { fauxAssistantMessage: assistant, fauxToolCall: toolCall } = ai;
export const usage = (n = 10) => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: n, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export const user = (content) => ({ role: "user", content, timestamp: Date.now() });

/** 使用真实 SDK 和离线 provider；所有写入只进入临时目录。 */
export async function createHarness(options = {}) {
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "pi-compact-integration-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-compact.json"), JSON.stringify(options.config ?? {}));
  const modelRuntime = await ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  const faux = ai.fauxProvider({
    provider: "pi-compact-test", api: "pi-compact-test",
    models: [{ id: "local", contextWindow: options.contextWindow ?? 200000, maxTokens: 4096 }],
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({
    retry: { enabled: false }, cacheWarming: { enabled: false },
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 0, ...options.compaction },
  });
  const events = [], errors = [], preparations = [], notifications = [];
  const bus = createEventBus();
  const loaded = await loadExtensions([fileURLToPath(new URL("../../index.ts", import.meta.url))], cwd, bus);
  assert.deepEqual(loaded.errors, []);
  const observer = await loadExtensionFromFactory((pi) => {
    pi.on("session_before_compact", (event) => { preparations.push(event.preparation); });
    options.observe?.(pi);
  }, cwd, bus, loaded.runtime, "<integration-observer>");
  loaded.extensions.unshift(observer);
  if (options.after) loaded.extensions.push(await loadExtensionFromFactory(options.after, cwd, bus, loaded.runtime, "<integration-after>"));
  const resourceLoader = {
    getExtensions: () => loaded,
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "仅用于本地集成测试。", getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
  };
  const sm = options.persistent ? SessionManager.create(cwd, join(cwd, "sessions")) : SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime, model: faux.getModel(), settingsManager: settings, sessionManager: sm,
    resourceLoader, noTools: "builtin", customTools: options.customTools,
  });
  session.agent.toolExecution = options.toolExecution ?? "parallel";
  session.subscribe((event) => events.push(event));
  await session.bindExtensions({ mode: "rpc", uiContext: { notify: (message) => notifications.push(message) }, onError: (error) => errors.push(error) });
  return {
    cwd, sm, session, faux, events, errors, notifications, preparations,
    queue: (...messages) => faux.setResponses(messages),
    sync: () => session.agent.state.messages = sm.buildSessionContext().messages,
    tool: (name) => session.agent.state.tools.find((tool) => tool.name === name),
    compactions: () => sm.getEntries().filter((entry) => entry.type === "compaction"),
    close() { session.dispose(); if (!options.cwd) rmSync(cwd, { recursive: true, force: true }); },
  };
}

/** 等待具体生命周期事件而非轮询；超时会让测试明确失败。 */
export function untilEvent(harness, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("等待 Pi 生命周期事件超时")); }, 5000);
    const unsubscribe = harness.session.subscribe((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}
