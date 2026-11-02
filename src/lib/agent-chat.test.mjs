import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyTurnEvent,
  applyTurnToList,
  chatAge,
  composerMode,
  isExternalLink,
  isTurnActive,
} from "./agent-chat.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAT_RS = readFileSync(
  path.join(HERE, "..", "..", "src-tauri", "src", "agent_tasks", "chat.rs"),
  "utf8",
);

const turn = (status, extra = {}) => ({
  id: `turn-${status}`,
  text: "Find flights",
  kind: "start",
  steers: [],
  profileId: "p1",
  taskId: "t1",
  status,
  steps: [],
  approval: null,
  result: null,
  error: null,
  creditsUsed: 0,
  startedAt: 1,
  finishedAt: null,
  ...extra,
});

const chat = (turns, updatedAt = 10) => ({
  id: "c1",
  title: "Find flights",
  profileId: "p1",
  createdAt: 1,
  updatedAt,
  turns,
});

test("the composer starts, follows up, or steers", () => {
  assert.equal(composerMode(null), "start");
  assert.equal(composerMode(chat([turn("done")])), "followUp");
  assert.equal(composerMode(chat([turn("failed")])), "followUp");
  for (const status of ["launching", "running", "paused", "needs_approval"]) {
    assert.equal(composerMode(chat([turn(status)])), "steer", status);
    assert.ok(isTurnActive({ status }));
  }
  assert.ok(!isTurnActive(null));
});

test("a turn event replaces its turn and never goes back in time", () => {
  const before = chat([turn("done"), turn("running")], 10);
  const next = applyTurnEvent(before, {
    chatId: "c1",
    index: 1,
    updatedAt: 12,
    turn: turn("done", { result: "**ok**" }),
  });
  assert.equal(next.turns[1].status, "done");
  assert.equal(next.updatedAt, 12);
  assert.equal(before.turns[1].status, "running", "the old chat is untouched");

  const added = applyTurnEvent(before, {
    chatId: "c1",
    index: 2,
    updatedAt: 11,
    turn: turn("launching"),
  });
  assert.equal(added.turns.length, 3);

  for (const event of [
    { chatId: "c2", index: 1, updatedAt: 20, turn: turn("done") },
    { chatId: "c1", index: 1, updatedAt: 9, turn: turn("done") },
    { chatId: "c1", index: 5, updatedAt: 20, turn: turn("done") },
  ]) {
    assert.equal(applyTurnEvent(before, event), before);
  }
});

test("the list moves a changed chat to the top", () => {
  const list = [
    { id: "a", updatedAt: 30, status: "done", turns: 1 },
    { id: "b", updatedAt: 20, status: "done", turns: 2 },
  ];
  const next = applyTurnToList(list, {
    chatId: "b",
    index: 2,
    updatedAt: 40,
    turn: turn("running"),
  });
  assert.deepEqual(
    next.map((c) => [c.id, c.status, c.turns]),
    [
      ["b", "running", 3],
      ["a", "done", 1],
    ],
  );
  assert.equal(
    applyTurnToList(list, {
      chatId: "x",
      index: 0,
      updatedAt: 1,
      turn: turn("done"),
    }),
    list,
  );
});

test("only web links open from an answer", () => {
  assert.ok(isExternalLink("https://example.com/a"));
  assert.ok(isExternalLink("http://example.com"));
  for (const href of [
    undefined,
    "",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "/relative",
    "mailto:a@b.c",
  ]) {
    assert.ok(!isExternalLink(href), String(href));
  }
});

test("a chat's age reads as now, a time today, or a date", () => {
  const now = new Date(2026, 10, 2, 15, 0).getTime();
  assert.deepEqual(chatAge(now - 5_000, now, "en"), { kind: "now" });
  const today = chatAge(now - 3 * 3_600_000, now, "en");
  assert.equal(today.kind, "text");
  assert.match(today.text, /12/);
  const older = chatAge(new Date(2026, 9, 3).getTime(), now, "en");
  assert.match(older.text, /Oct/);
  const lastYear = chatAge(new Date(2025, 9, 3).getTime(), now, "en");
  assert.match(lastYear.text, /2025/);
});

test("turn kinds match the Rust wire names", () => {
  const block = CHAT_RS.slice(
    CHAT_RS.indexOf("pub enum TurnKind"),
    CHAT_RS.indexOf("}", CHAT_RS.indexOf("pub enum TurnKind")),
  );
  const variants = [...block.matchAll(/^\s+([A-Z]\w+),/gm)].map((m) =>
    m[1].replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase()),
  );
  assert.deepEqual(variants, ["start", "follow_up", "fresh"]);
});
