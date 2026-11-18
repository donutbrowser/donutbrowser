import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentActivityStore,
  newestPerProfile,
  preferRow,
  readResult,
  resultLine,
} from "./agent-activity.ts";

function turn(profileId, status, extra = {}) {
  return {
    id: `turn-${profileId}`,
    text: "Check the proxy",
    kind: "start",
    steers: [],
    hostCalls: [],
    profileId,
    taskId: "task",
    status,
    steps: [],
    approval: null,
    result: null,
    error: null,
    creditsUsed: 0,
    startedAt: 1_000,
    finishedAt: null,
    ...extra,
  };
}

function batch(id, createdAt, tasks) {
  return {
    id,
    routineId: null,
    prompt: "Check",
    startUrl: null,
    autonomy: "ask",
    maxCredits: null,
    headless: false,
    concurrency: 2,
    createdAt,
    stopping: false,
    finished: false,
    tasks: tasks.map(([profileId, status, finishedAt = null]) => ({
      profileId,
      taskId: null,
      runId: null,
      status,
      lastStep: null,
      stepCount: 0,
      approval: null,
      result: status === "done" ? "Done there" : null,
      error: null,
      creditsUsed: 0,
      startedAt: createdAt,
      finishedAt,
    })),
    tally: {
      queued: 0,
      active: 0,
      done: 0,
      failed: 0,
      stopped: 0,
      creditsUsed: 0,
    },
  };
}

test("live work wins over a newer ending, and the newest ending wins otherwise", () => {
  const row = (status, at, id = "a") => ({
    source: { kind: "chat", id },
    status,
    step: null,
    url: null,
    result: null,
    error: null,
    at,
  });
  assert.equal(preferRow(row("running", 1), row("done", 9)).status, "running");
  assert.equal(preferRow(row("done", 9), row("queued", 1)).status, "queued");
  assert.equal(preferRow(row("done", 1), row("failed", 9)).status, "failed");
  assert.equal(preferRow(undefined, row("done", 1)).status, "done");
});

test("the newest chat of each profile is the one read", () => {
  const picked = newestPerProfile([
    { id: "old", profileId: "p1", updatedAt: 1 },
    { id: "new", profileId: "p1", updatedAt: 5 },
    { id: "other", profileId: "p2", updatedAt: 2 },
  ]);
  assert.deepEqual(picked.map((chat) => chat.id).sort(), ["new", "other"]);
});

test("a table answer reads as names and values; prose keeps its first line", () => {
  const table =
    "| IP | Country | Match |\n|---|---|---|\n| 203.0.113.24 | DE | **yes** |";
  assert.deepEqual(readResult(table).fields, [
    ["IP", "203.0.113.24"],
    ["Country", "DE"],
    ["Match", "yes"],
  ]);
  assert.equal(
    resultLine(table),
    "IP: 203.0.113.24 · Country: DE · Match: yes",
  );
  const prose =
    "**Three fares** match. See [the rules](https://x.test).\n\n- one\n```\ncode\n```";
  assert.equal(resultLine(prose), "Three fares match. See the rules.");
  assert.deepEqual(readResult(prose).lines, [
    "Three fares match. See the rules.",
    "one",
  ]);
});

test("a step tells only its own row, and a run shows on each of its profiles", () => {
  const store = new AgentActivityStore();
  const heard = { p1: 0, p2: 0 };
  store.subscribe("p1", () => {
    heard.p1 += 1;
  });
  store.subscribe("p2", () => {
    heard.p2 += 1;
  });
  store.setChats([
    {
      id: "c1",
      title: "Check",
      profileId: "p1",
      createdAt: 1,
      updatedAt: 1_000,
      turns: [turn("p1", "done", { result: "All good", finishedAt: 1_500 })],
    },
  ]);
  assert.equal(store.get("p1").status, "done");
  assert.deepEqual(heard, { p1: 1, p2: 0 });

  store.applyTurn({
    chatId: "c1",
    index: 1,
    updatedAt: 2_000,
    turn: turn("p1", "running", {
      steps: [{ index: 0, kind: "act", text: "Opening the page", at: 2_000 }],
    }),
  });
  assert.equal(store.get("p1").step, "Opening the page");
  assert.deepEqual(heard, { p1: 2, p2: 0 });

  store.applyBatch(
    batch("b1", 3_000, [
      ["p1", "done", 3_500],
      ["p2", "queued"],
    ]),
  );
  assert.equal(store.get("p1").source.kind, "chat", "the live chat stays");
  assert.equal(store.get("p2").source.kind, "run");
  assert.equal(store.get("p2").status, "queued");
  assert.deepEqual(heard, { p1: 2, p2: 1 });
  assert.equal(store.summary().used, true);

  store.clear();
  assert.equal(store.get("p1"), undefined);
  assert.equal(store.summary().used, false);
});

test("an older turn event never replaces a newer one", () => {
  const store = new AgentActivityStore();
  store.applyTurn({
    chatId: "c1",
    index: 2,
    updatedAt: 5_000,
    turn: turn("p1", "done", { result: "New" }),
  });
  store.applyTurn({
    chatId: "c1",
    index: 1,
    updatedAt: 6_000,
    turn: turn("p1", "running"),
  });
  assert.equal(store.get("p1").result, "New");
});
