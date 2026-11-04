import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendStep,
  batchProgress,
  batchStatus,
  creditsLeft,
  cronWords,
  groupRoutineRuns,
  isCron,
  isTaskActive,
  isTaskFinal,
  isWebUrl,
  MAX_CONCURRENCY,
  MAX_PROMPT_CHARS,
  nextRunAt,
  promptTitle,
  REPEAT_PRESETS,
  repeatCron,
  repeatParts,
  routineFromBatch,
  routineFromTurn,
  rowsForAttention,
  stateCounts,
  TASK_STATUSES,
  taskState,
  upsertBatch,
} from "./agent-tasks.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUST = (file) =>
  readFileSync(
    path.join(HERE, "..", "..", "src-tauri", "src", "agent_tasks", file),
    "utf8",
  );

function rustConst(source, name) {
  const match = source.match(new RegExp(`const ${name}: usize = ([\\d_]+);`));
  assert.ok(match, `${name} is no longer declared`);
  return Number(match[1].replaceAll("_", ""));
}

test("the limits match the backend", () => {
  assert.equal(
    MAX_PROMPT_CHARS,
    rustConst(RUST("cloud.rs"), "MAX_PROMPT_CHARS"),
  );
  assert.equal(MAX_CONCURRENCY, rustConst(RUST("batch.rs"), "MAX_CONCURRENCY"));
});

test("every task status the backend sends is known here", () => {
  const source = RUST("model.rs");
  const body = source.slice(
    source.indexOf("pub enum TaskStatus"),
    source.indexOf("}", source.indexOf("pub enum TaskStatus")),
  );
  const variants = [...body.matchAll(/^\s+([A-Z][A-Za-z]+),$/gm)].map((m) =>
    m[1].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
  );
  assert.deepEqual([...TASK_STATUSES].sort(), variants.sort());
});

test("a status is active, final or queued, and has one tone", () => {
  for (const status of TASK_STATUSES) {
    const kinds = [
      isTaskActive(status),
      isTaskFinal(status),
      status === "queued",
    ].filter(Boolean);
    assert.equal(kinds.length, 1, status);
    assert.ok(taskState(status));
  }
  assert.equal(taskState("running"), "working");
  assert.equal(taskState("launching"), "working");
  assert.equal(taskState("done"), "done");
  assert.equal(taskState("budget"), "failed");
  assert.equal(taskState("needs_approval"), "needs_you");
  assert.equal(taskState("queued"), "idle");
  assert.equal(taskState("missed"), "idle");
});

test("progress, titles and credits read plainly", () => {
  assert.equal(
    batchProgress({ done: 2, failed: 1, stopped: 1, queued: 4, active: 2 }, 10),
    40,
  );
  assert.equal(batchProgress({ done: 0, failed: 0, stopped: 0 }, 0), 0);
  assert.equal(promptTitle("Check the inbox\nthen reply"), "Check the inbox");
  assert.equal(promptTitle("x".repeat(100), 10).length, 10);
  assert.deepEqual(
    creditsLeft({ allowance: 10000, extra: 0, used: 2500, balance: 7500 }),
    { left: 7500, percentUsed: 25 },
  );
  assert.equal(creditsLeft({ unlimited: true }), null);
  assert.ok(isCron("0 9 * * 1-5"));
  assert.ok(!isCron("daily"));
  assert.ok(isWebUrl("https://example.com/a"));
  assert.ok(!isWebUrl("file:///etc/passwd"));
});

test("batches and steps merge without duplicates", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  assert.deepEqual(
    upsertBatch([a], b).map((x) => x.id),
    ["b", "a"],
  );
  const updated = upsertBatch([b, a], { id: "a", prompt: "new" });
  assert.equal(updated[1].prompt, "new");
  const steps = appendStep(appendStep([], { index: 2 }), { index: 1 });
  assert.deepEqual(
    appendStep(steps, { index: 2 }).map((s) => s.index),
    [1, 2],
  );
});

test("a task that needs the person floats up; the rest keep their place", () => {
  const tasks = [
    { profileId: "a", status: "done" },
    { profileId: "b", status: "running" },
    { profileId: "c", status: "needs_approval" },
    { profileId: "d", status: "failed" },
  ];
  assert.deepEqual(
    rowsForAttention(tasks).map((task) => task.profileId),
    ["c", "a", "b", "d"],
  );
  assert.deepEqual(
    rowsForAttention(tasks, "failed").map((task) => task.profileId),
    ["d"],
  );
  assert.deepEqual(stateCounts(tasks), {
    working: 1,
    needs_you: 1,
    done: 1,
    failed: 1,
    idle: 0,
  });
});

test("routine runs group by batch, newest first, with their credits", () => {
  const run = (runId, batchId, createdAt, creditsUsed) => ({
    runId,
    batchId,
    profileId: runId,
    status: "done",
    summary: null,
    creditsUsed,
    error: null,
    createdAt,
    finishedAt: null,
  });
  const groups = groupRoutineRuns([
    run("1", "old", "2026-10-01T09:00:00Z", 5),
    run("2", "new", "2026-10-02T09:00:00Z", 7),
    run("3", "new", "2026-10-02T09:00:01Z", null),
  ]);
  assert.deepEqual(
    groups.map((group) => [
      group.batchId,
      group.runs.length,
      group.creditsUsed,
    ]),
    [
      ["new", 2, 7],
      ["old", 1, 5],
    ],
  );
});

test("common schedules read as words", () => {
  assert.deepEqual(cronWords("0 9 * * 1-5"), {
    kind: "weekdays",
    minute: 0,
    hour: 9,
  });
  assert.deepEqual(cronWords("30 7 * * *"), {
    kind: "daily",
    minute: 30,
    hour: 7,
  });
  assert.deepEqual(cronWords("0 18 * * 7"), {
    kind: "weekly",
    minute: 0,
    hour: 18,
    weekday: 0,
  });
  assert.deepEqual(cronWords("15 * * * *"), { kind: "hourly", minute: 15 });
  assert.deepEqual(cronWords("*/10 * * * *"), { kind: "minutes", every: 10 });
  assert.deepEqual(cronWords("0 9 1 * *"), { kind: "custom" });
  assert.deepEqual(cronWords("nonsense"), { kind: "custom" });
});

test("a schedule reads back into the shape it was chosen with", () => {
  for (const cron of [
    "15 * * * *",
    "30 9 * * *",
    "0 18 * * 1-5",
    "45 7 * * 3",
  ]) {
    assert.equal(repeatCron(repeatParts(cron)), cron);
  }
  const custom = repeatParts("*/15 9-17 * * 1-5");
  assert.equal(custom.preset, "custom");
  assert.equal(repeatCron(custom), "*/15 9-17 * * 1-5");
  const weekly = repeatParts("0 9 * * 1");
  assert.deepEqual(
    REPEAT_PRESETS.map((preset) => repeatCron({ ...weekly, preset })),
    ["0 * * * *", "0 9 * * *", "0 9 * * 1-5", "0 9 * * 1", "0 9 * * 1"],
  );
});

function turn(kind, text, steps = []) {
  return { kind, text, steps, status: "done" };
}

test("a chat turn becomes a routine with the words since its task began", () => {
  const chat = {
    title: "Find the cheapest flight from Tirana to Lisbon next Friday morning",
    profileId: "p1",
    turns: [
      turn("start", "Old task"),
      turn("fresh", " Find the cheapest flight ", [
        { index: 0, kind: "act", text: "Open", url: "chrome://newtab" },
        { index: 1, kind: "act", text: "Open", url: "https://f.test/x" },
      ]),
      turn("follow_up", "Only direct ones"),
      turn("follow_up", "Later message"),
    ],
  };
  const draft = routineFromTurn(chat, 2);
  assert.equal(draft.prompt, "Find the cheapest flight\n\nOnly direct ones");
  assert.equal(draft.startUrl, "https://f.test/x");
  assert.deepEqual(draft.profileIds, ["p1"]);
  assert.ok(draft.name.length <= 60 && draft.name.endsWith("…"));
  assert.equal(draft.schedule, null);
  assert.equal(routineFromTurn(chat, 0).prompt, "Old task");
});

test("a run becomes a routine on its profiles, and shows its most urgent state", () => {
  const tally = {
    queued: 0,
    active: 0,
    done: 2,
    failed: 0,
    stopped: 0,
    creditsUsed: 9,
  };
  const batch = {
    prompt: "Check the inbox",
    startUrl: null,
    maxCredits: 300,
    finished: true,
    tally,
    tasks: [
      { profileId: "a", status: "done" },
      { profileId: "b", status: "done" },
    ],
  };
  const draft = routineFromBatch(batch);
  assert.deepEqual(draft.profileIds, ["a", "b"]);
  assert.equal(draft.maxCreditsPerRun, 300);
  assert.equal(batchStatus(batch), "done");
  assert.equal(
    batchStatus({ ...batch, tally: { ...tally, failed: 1 } }),
    "failed",
  );
  assert.equal(
    batchStatus({
      ...batch,
      finished: false,
      tasks: [{ status: "needs_approval" }],
    }),
    "needs_approval",
  );
  assert.equal(batchStatus({ ...batch, finished: false }), "running");
});

test("a schedule's next run is the first time after now that it fires", () => {
  const zone = "Europe/Tirane";
  const at = (text) => new Date(text);
  // 2026-11-05 is a Thursday.
  const thursday = at("2026-11-05T10:30:00");
  const next = (cron) =>
    nextRunAt({ cron, timezone: zone }, thursday, zone)?.toString();
  assert.equal(next("0 9 * * 1-5"), at("2026-11-06T09:00:00").toString());
  assert.equal(next("45 10 * * *"), at("2026-11-05T10:45:00").toString());
  assert.equal(next("0 8 * * 0,6"), at("2026-11-07T08:00:00").toString());
  assert.equal(next("0 9 * * 4"), at("2026-11-12T09:00:00").toString());
  assert.equal(next("15 * * * *"), at("2026-11-05T11:15:00").toString());
  assert.equal(next("*/20 * * * *"), at("2026-11-05T10:40:00").toString());
  assert.equal(next("0 9 1 * *"), undefined);
  assert.equal(
    nextRunAt({ cron: "0 9 * * *", timezone: "Asia/Tokyo" }, thursday, zone),
    null,
  );
  assert.equal(nextRunAt(null, thursday, zone), null);
});
