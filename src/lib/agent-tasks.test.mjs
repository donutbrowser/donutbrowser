import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendStep,
  batchProgress,
  creditsLeft,
  cronWords,
  groupRoutineRuns,
  isCron,
  isTaskActive,
  isTaskFinal,
  isWebUrl,
  MAX_CONCURRENCY,
  MAX_PROMPT_CHARS,
  promptTitle,
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
