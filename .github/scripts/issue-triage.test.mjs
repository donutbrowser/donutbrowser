import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { issueLine, reviewLine } from "./bot-text.mjs";
import {
  AREAS,
  buildSystemPrompt,
  buildUserPrompt,
  decide,
  parseFields,
  readFacts,
} from "./issue-triage.mjs";
import { renderReview } from "./pr-review.mjs";

const BUG = `### What happened?

The profile does not start.

### Steps to reproduce

1. Click Launch

### Platform

Windows: installer

### Donut Browser version

0.35.2

### Wayfern version

unknown

### Last version that worked

_No response_

### Error logs or screenshots

_No response_

### Did you use AI to write this report?

No`;

const facts = (body = BUG) => readFacts({ body, latestVersion: "v0.36.0" });
const plan = (result, extra = {}) =>
  decide({
    result: { action: "keep", kind: "bug", ...result },
    facts: facts(),
    issueText: "title\nbody",
    ...extra,
  });

test("the issue form is read without a model", () => {
  assert.equal(parseFields(BUG)["Wayfern version"], "unknown");
  assert.deepEqual(facts(), {
    template: "bug",
    os: "windows",
    platform: "Windows: installer",
    version: "behind",
    reportedVersion: "0.35.2",
    latestVersion: "0.36.0",
    lastWorking: false,
    hasLogs: false,
    hasAttachment: false,
  });
  const legacy = facts(
    BUG.replace("### Platform", "### Operating System")
      .replace("0.35.2", "nightly-2026-11-01")
      .replace(
        "### Error logs or screenshots\n\n_No response_",
        "### Error logs or screenshots\n\n[ERROR] boom",
      ),
  );
  assert.equal(legacy.os, "windows");
  assert.equal(legacy.version, "nightly");
  assert.equal(legacy.hasLogs, true);
});

test("a complete issue from a returning author gets no comment", () => {
  const body = BUG.replace("0.35.2", "0.36.0");
  const result = decide({
    result: { action: "keep", kind: "bug", areas: ["launch"], logs: "no" },
    facts: facts(body),
    issueText: body,
  });
  assert.equal(result.comment, "");
  assert.deepEqual(result.addLabels, ["bug", "area:launch", "os:windows"]);
});

test("the comment is the thanks, the answer, three questions, related issues", () => {
  const result = plan(
    {
      areas: ["proxy", "nonsense"],
      logs: "copy",
      answer: "This error occurs when software intercepts local connections.",
      questions: [
        "Does the proxy check in the app pass?",
        "1. Does the proxy check in the app pass?",
        "Which antivirus runs on this computer?",
        "Does a new profile with no proxy start?",
      ],
      related: [12, 999, 13, 14],
    },
    {
      firstTime: true,
      labels: ["enhancement"],
      candidates: [12, 13, 14].map((number) => ({ number })),
    },
  );
  assert.equal(
    result.comment,
    [
      "Thanks for opening your first issue!",
      "",
      "This error occurs when software intercepts local connections.",
      "",
      "Needed to continue:",
      "1. Does this occur in v0.36.0? You reported 0.35.2.",
      "2. Does the proxy check in the app pass?",
      "3. Paste the logs: Settings → Advanced → Copy logs.",
      "",
      "Possibly related: #12, #13.",
    ].join("\n"),
  );
  assert.deepEqual(result.addLabels, [
    "bug",
    "area:proxy",
    "os:windows",
    "needs-info",
  ]);
  assert.deepEqual(result.removeLabels, ["enhancement"]);
});

test("an app that does not start gets the log file of its OS", () => {
  const result = plan({ logs: "file" });
  assert.match(result.comment, /%LOCALAPPDATA%\\com\.donutbrowser\\logs/u);
  assert.doesNotMatch(result.comment, /Library\/Logs|\.local\/share/u);
});

test("what the bot must never say is dropped", () => {
  const banned = [
    "The likely cause is the proxy worker, can you confirm?",
    "Is `proxy_server.rs` involved in this?",
    "Thanks for the well-documented report, which proxy do you use?",
    "What is your proxy password?",
    "Is the subscription check failing for you?",
    "Does https://evil.example/page show the same result?",
    "Paste the logs here?",
    "Which Donut Browser version is this?",
  ];
  const result = plan({ logs: "no", questions: banned, answer: banned[0] });
  assert.equal(
    result.comment,
    "Needed to continue:\n1. Does this occur in v0.36.0? You reported 0.35.2.",
  );
  assert.equal(issueLine("ping @zhom and **read** this"), "ping zhom and read this");
  assert.equal(
    issueLine("See https://donutbrowser.com/docs/self-hosting for the steps."),
    "See https://donutbrowser.com/docs/self-hosting for the steps.",
  );
  assert.equal(issueLine("a\nb\n\n- c ".repeat(80)).length, 240);
});

test("a delete needs the author's own words", () => {
  const issueText = "Garbage   project\nthe dev is an IDIOT";
  const real = plan(
    { action: "delete", insult_quote: "the dev is an idiot" },
    { issueText },
  );
  assert.equal(real.action, "delete");
  assert.equal(real.insultQuote, "the dev is an idiot");
  const invented = plan(
    { action: "delete", insult_quote: "you are all fools" },
    { issueText },
  );
  assert.equal(invented.action, "keep");
  assert.equal(invented.degraded.length, 1);
});

test("a close says what is missing and nothing else", () => {
  const result = plan({
    action: "close",
    close_reasons: ["What went wrong.", "what went wrong"],
    questions: ["Which page?"],
  });
  assert.equal(result.comment, "");
  assert.deepEqual(result.addLabels, []);
  assert.match(result.closeComment, /^Closed: .*\n\nMissing:\n- What went wrong\.\n\n/u);
});

test("a maintainer's issue gets labels only and is never closed", () => {
  const result = plan(
    { action: "close", areas: ["sync"], questions: ["Cloud or self-hosted?"] },
    { maintainer: true, firstTime: true },
  );
  assert.equal(result.action, "keep");
  assert.equal(result.comment, "");
  assert.deepEqual(result.addLabels, ["bug", "area:sync", "os:windows"]);
});

test("with no model answer nothing is closed and only facts are asked", () => {
  const result = decide({ result: null, facts: facts(), issueText: "" });
  assert.equal(result.action, "keep");
  assert.equal(
    result.comment,
    "Needed to continue:\n1. Does this occur in v0.36.0? You reported 0.35.2.",
  );
  const wrong = decide({ result: { action: "ban" }, facts: facts(), issueText: "" });
  assert.equal(wrong.action, "keep");
  assert.equal(wrong.degraded.length, 1);
});

test("the prompt holds public knowledge and no repository guidelines", () => {
  const knowledge = fs.readFileSync(
    new URL("../triage/knowledge.md", import.meta.url),
    "utf8",
  );
  for (const area of AREAS) assert.match(knowledge, new RegExp(`- \`${area}\`:`, "u"));
  const system = buildSystemPrompt(knowledge);
  assert.doesNotMatch(system, /src-tauri|\.rs\b|CLAUDE\.md|AGENTS\.md/u);
  assert.ok(system.length < 12000);
  const user = buildUserPrompt({
    title: "t",
    body: "b",
    facts: facts(),
    candidates: [{ number: 7, state: "open", title: "Proxy fails" }],
  });
  assert.match(user, /logs in the issue: no/u);
  assert.match(user, /#7 \[open\] Proxy fails/u);
});

test("a review keeps findings on changed files only", () => {
  const changedFiles = ["src/a.ts", "src/b.ts"];
  const result = {
    findings: [
      { file: "src/a.ts", note: "`load()` is called before the token is set." },
      { file: "src/secret.ts", note: "This file is not in the pull request." },
      { file: "src/b.ts", note: "Great catch, well-structured change overall." },
      { file: "src/b.ts", note: "`load()` is called before the token is set" },
    ],
  };
  assert.equal(
    renderReview({ result, changedFiles, firstTime: true }),
    "Thanks for your first PR!\n\nAutomated review. Check each point:\n- `src/a.ts`: `load()` is called before the token is set.",
  );
  assert.equal(renderReview({ result: { findings: [] }, changedFiles }), "");
  assert.equal(renderReview({ result: null, changedFiles, firstTime: true }), "Thanks for your first PR!");
  assert.equal(reviewLine("Check src/a.ts line 4: the lock is held across await."), "Check src/a.ts line 4: the lock is held across await.");
});
