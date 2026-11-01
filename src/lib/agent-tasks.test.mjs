import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendStep,
  batchProgress,
  creditsLeft,
  isCron,
  isTaskActive,
  isTaskFinal,
  isWebUrl,
  MAX_CONCURRENCY,
  MAX_PROMPT_CHARS,
  promptTitle,
  statusTone,
  TASK_STATUSES,
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
    assert.ok(statusTone(status));
  }
  assert.equal(statusTone("done"), "success");
  assert.equal(statusTone("failed"), "destructive");
  assert.equal(statusTone("needs_approval"), "warning");
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
