import assert from "node:assert/strict";
import test from "node:test";
import { focusOf, newWaits } from "./agent-inbox.ts";
import { isHttpsUrl, isSlackUrl } from "./agent-integrations.ts";
import { splitSites } from "./agent-playbooks.ts";
import {
  cellText,
  optionsTuned,
  routineDraft,
  routineFromPrompt,
  routineOptions,
  tableTsv,
} from "./agent-tasks.ts";

test("a table copies as tab-separated rows a spreadsheet takes", () => {
  const table = {
    batchId: "b1",
    columns: [
      { name: "Orders", type: "number" },
      { name: "Note", type: "text" },
      { name: "Paid", type: "bool" },
    ],
    rows: [
      {
        runId: "r1",
        profileId: "p1",
        status: "done",
        finishedAt: null,
        data: { Orders: 3, Note: "two\tlines\nhere", Paid: false },
      },
      {
        runId: "r2",
        profileId: null,
        status: "failed",
        finishedAt: null,
        data: {},
      },
    ],
  };
  const names = { p1: "Store EU" };
  const tsv = tableTsv(table, (id) => names[id] ?? "?");
  assert.equal(
    tsv,
    "\tOrders\tNote\tPaid\nStore EU\t3\ttwo lines here\tfalse\n?\t\t\t",
  );
  assert.equal(cellText(null), "");
  assert.equal(cellText(undefined), "");
  assert.equal(cellText(0), "0");
});

test("a new routine and a saved one keep the options as the cloud takes them", () => {
  const draft = routineFromPrompt("Check the orders", ["p1"]);
  assert.equal(draft.effort, null, "null is the default");
  assert.deepEqual(draft.playbookIds, []);
  assert.deepEqual(routineOptions(draft), {
    effort: "standard",
    pace: "human",
    caps: null,
  });
  const saved = {
    ...draft,
    id: "r1",
    hook: { url: "https://api.donutbrowser.com/hooks/agent/x" },
    nextRunAt: null,
    createdAt: null,
    updatedAt: null,
    effort: "thorough",
  };
  const back = routineDraft(saved);
  assert.equal(back.effort, "thorough");
  assert.ok(!("hook" in back) && !("id" in back), "only the cloud sets these");
  assert.equal(optionsTuned(routineOptions(back)), true);
  assert.equal(
    optionsTuned({ effort: "standard", pace: "human", caps: null }),
    false,
  );
});

test("a wait is new once, and opens its chat or its run's profile", () => {
  const wait = (key, extra) => ({
    key,
    kind: "question",
    profileId: "p1",
    batchId: null,
    chatId: null,
    routineId: null,
    title: "t",
    text: "q",
    subject: null,
    at: 1,
    ...extra,
  });
  const seen = new Set(["a"]);
  assert.deepEqual(
    newWaits(seen, [wait("a"), wait("b")]).map((w) => w.key),
    ["b"],
  );
  assert.deepEqual(focusOf(wait("c", { chatId: "c1" })), {
    kind: "chat",
    id: "c1",
  });
  assert.deepEqual(focusOf(wait("d", { batchId: "b1" })), {
    kind: "run",
    id: "b1",
    profileId: "p1",
  });
  assert.deepEqual(focusOf(wait("e")), { kind: "inbox" });
});

test("sites and delivery addresses are read as people type them", () => {
  assert.deepEqual(splitSites(" shop.example, mail.example\nshop.example "), [
    "shop.example",
    "mail.example",
  ]);
  assert.equal(isHttpsUrl("https://hooks.slack.com/services/T/B/x"), true);
  assert.equal(isHttpsUrl("http://example.com/hook"), false);
  assert.equal(isSlackUrl("https://hooks.slack.com/services/T/B/x"), true);
  assert.equal(isSlackUrl("https://example.com/slack"), false);
});
