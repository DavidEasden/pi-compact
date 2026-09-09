import assert from "node:assert/strict";
import test from "node:test";
import { analyzeAutoRecallQuery } from "../src/core/auto-recall.ts";
import { searchRecords, recordsFromEntries } from "../src/core/session.ts";
import type { SessionEntryLike } from "../src/types.ts";

const ineligible = [
  "continue",
  "Continue.",
  "please continue",
  "请继续",
  "请继续！",
  "继续",
  "好的",
  "ok",
  "OK.",
  "okay",
  "谢谢",
  "上一步",
  "再试一次",
  "try again",
  "keep going",
  "got it",
  "thanks",
];

test("会话控制/礼貌/泛词不能单独成为自动召回查询", () => {
  for (const query of ineligible) {
    const analysis = analyzeAutoRecallQuery(query);
    assert.equal(analysis.eligible, false, query);
    assert.deepEqual(analysis.terms, [], query);
  }
});

test("普通词不得被当成 error-code 强信号", () => {
  for (const query of ["end", "email", "error", "ab12"]) {
    const analysis = analyzeAutoRecallQuery(query);
    assert.equal(analysis.signals.includes("error-code"), false, query);
  }
  assert.equal(analyzeAutoRecallQuery("end").eligible, false);
  assert.equal(analyzeAutoRecallQuery("email").eligible, false);
  assert.equal(analyzeAutoRecallQuery("error").eligible, false);

  const eacces = analyzeAutoRecallQuery("EACCES");
  assert.equal(eacces.eligible, true);
  assert.ok(eacces.signals.includes("error-code"));
  assert.ok(eacces.terms.includes("eacces"));

  const refused = analyzeAutoRecallQuery("ECONNREFUSED");
  assert.equal(refused.eligible, true);
  assert.ok(refused.signals.includes("error-code"));
  assert.ok(refused.terms.includes("econnrefused"));

  const err = analyzeAutoRecallQuery("ERR_STREAM_DESTROYED");
  assert.equal(err.eligible, true);
  assert.ok(err.signals.includes("error-code"));
  assert.ok(err.terms.includes("err_stream_destroyed"));

  const http = analyzeAutoRecallQuery("HTTP 500");
  assert.equal(http.eligible, true);
  assert.ok(http.signals.includes("error-code"));
  assert.ok(http.terms.some((term) => term.includes("500")));

  const ticket = analyzeAutoRecallQuery("ABC-123");
  assert.equal(ticket.eligible, true);
  assert.ok(ticket.signals.includes("error-code"));
  assert.ok(ticket.terms.includes("abc-123"));
});

test("泛化请求不能凭功能词或疑问词通过自动召回", () => {
  for (const query of ["look at this", "what is it", "帮我看看", "为什么", "怎么样", "哪里"]) {
    const analysis = analyzeAutoRecallQuery(query);
    assert.equal(analysis.eligible, false, query);
    assert.deepEqual(analysis.terms, [], query);
  }
});

test("具体路径、错误码、标识符、命令或多词主题仍可自动召回", () => {
  const pathQuery = analyzeAutoRecallQuery("src/auth/session.ts");
  assert.equal(pathQuery.eligible, true);
  assert.ok(pathQuery.signals.includes("path"));
  assert.ok(pathQuery.terms.some((term) => term.includes("session.ts")));

  const errorQuery = analyzeAutoRecallQuery("ECONNREFUSED");
  assert.equal(errorQuery.eligible, true);
  assert.ok(errorQuery.signals.includes("error-code"));
  assert.ok(errorQuery.terms.includes("econnrefused"));

  const identQuery = analyzeAutoRecallQuery("refreshToken");
  assert.equal(identQuery.eligible, true);
  assert.ok(identQuery.signals.includes("identifier"));
  assert.ok(identQuery.terms.includes("refreshtoken"));

  const commandQuery = analyzeAutoRecallQuery("npm test");
  assert.equal(commandQuery.eligible, true);
  assert.ok(commandQuery.signals.includes("command") || commandQuery.signals.includes("multi-term"));

  const gitQuery = analyzeAutoRecallQuery("git diff");
  assert.equal(gitQuery.eligible, true);
  assert.ok(gitQuery.signals.includes("command"));
  assert.ok(gitQuery.terms.includes("git diff"));

  const topicQuery = analyzeAutoRecallQuery("token 刷新");
  assert.equal(topicQuery.eligible, true);
  assert.ok(topicQuery.signals.includes("multi-term"));
  assert.ok(topicQuery.terms.includes("token"));
  assert.ok(topicQuery.terms.includes("刷新"));

  const deployQuery = analyzeAutoRecallQuery("deploy the auth service");
  assert.equal(deployQuery.eligible, true);
  assert.ok(deployQuery.signals.includes("multi-term"));
  assert.ok(deployQuery.terms.includes("deploy"));
  assert.ok(deployQuery.terms.includes("auth"));
  assert.ok(deployQuery.terms.includes("service"));

  const mixedQuery = analyzeAutoRecallQuery("请继续 token 刷新");
  assert.equal(mixedQuery.eligible, true);
  assert.equal(mixedQuery.terms.includes("继续"), false);
  assert.ok(mixedQuery.terms.includes("token"));
  assert.ok(mixedQuery.terms.includes("刷新"));
});

test("中文疑问词不得覆盖真正的内容词", () => {
  const analysis = analyzeAutoRecallQuery("为什么 token 刷新失败");
  assert.equal(analysis.eligible, true);
  assert.equal(analysis.terms.includes("为什么"), false);
  assert.ok(analysis.terms.includes("token"));
  assert.ok(analysis.terms.includes("刷新"));
  assert.ok(analysis.signals.includes("multi-term"));
});

test("make sure 与 e.g. 不得单独成为命令或路径强信号", () => {
  const sure = analyzeAutoRecallQuery("make sure");
  assert.equal(sure.eligible, false);
  assert.equal(sure.signals.includes("command"), false);
  assert.equal(sure.terms.includes("make sure"), false);

  const eg = analyzeAutoRecallQuery("e.g.");
  assert.equal(eg.eligible, false);
  assert.equal(eg.signals.includes("path"), false);

  const ie = analyzeAutoRecallQuery("i.e.");
  assert.equal(ie.eligible, false);
  assert.equal(ie.signals.includes("path"), false);

  const us = analyzeAutoRecallQuery("U.S.");
  assert.equal(us.eligible, false);
  assert.equal(us.signals.includes("path"), false);

  const npmTest = analyzeAutoRecallQuery("npm test");
  assert.equal(npmTest.eligible, true);
  assert.ok(npmTest.signals.includes("command"));

  const gitDiff = analyzeAutoRecallQuery("git diff");
  assert.equal(gitDiff.eligible, true);
  assert.ok(gitDiff.signals.includes("command"));

  const fileQuery = analyzeAutoRecallQuery("auth.ts");
  assert.equal(fileQuery.eligible, true);
  assert.ok(fileQuery.signals.includes("path"));
  assert.ok(fileQuery.terms.includes("auth.ts"));
});

test("手动检索仍可按泛词精确命中，不受自动召回门控影响", () => {
  const entries: SessionEntryLike[] = [
    { type: "message", id: "u1", message: { role: "user", content: "请继续处理刚才的工作" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "好的，我会继续" } },
    { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "look at this end email error" } },
  ];
  const records = recordsFromEntries(entries);
  assert.ok(searchRecords(records, "继续").length > 0);
  assert.ok(searchRecords(records, "好的").length > 0);
  assert.ok(searchRecords(records, "end").length > 0);
  assert.equal(analyzeAutoRecallQuery("继续").eligible, false);
  assert.equal(analyzeAutoRecallQuery("end").eligible, false);
  assert.equal(searchRecords(records, "end", { terms: ["does-not-exist"] }).length, 0);
});
