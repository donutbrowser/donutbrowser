import assert from "node:assert/strict";
import test from "node:test";
import {
  captureTableView,
  findTableViewByName,
  movableColumnOrder,
  moveTableColumn,
  orderTableColumns,
  pruneTableViewFilters,
  TABLE_VIEW_LIMIT,
  tableViewMatches,
  upsertTableView,
} from "./table-views.ts";

const state = {
  query: "  tag:work ",
  filters: { tag: ["b", "a", "a"], status: [], proxy: [""] },
  sorting: [{ id: "name", desc: true }],
  visibility: { note: false, dns: true },
  column_order: ["tags", "name"],
};

test("a captured view is trimmed and stable", () => {
  const view = captureTableView("v1", "  Work  ", state);
  assert.equal(view.name, "Work");
  assert.equal(view.query, "tag:work");
  assert.deepEqual(view.filters, { proxy: [""], tag: ["a", "b"] });
  assert.deepEqual(Object.keys(view.visibility), ["dns", "note"]);
  assert.equal(captureTableView("v", "x".repeat(200), state).name.length, 80);
});

test("a view matches the state it was saved from, and nothing else", () => {
  const view = captureTableView("v1", "Work", state);
  assert.equal(tableViewMatches(view, state), true);
  assert.equal(
    tableViewMatches(view, {
      ...state,
      filters: { tag: ["a", "b"], proxy: [""] },
    }),
    true,
    "empty filters and duplicate values do not count",
  );
  assert.equal(tableViewMatches(view, { ...state, query: "tag:home" }), false);
  assert.equal(
    tableViewMatches(view, {
      ...state,
      sorting: [{ id: "name", desc: false }],
    }),
    false,
  );
  assert.equal(
    tableViewMatches(view, { ...state, column_order: ["name", "tags"] }),
    false,
  );
  assert.equal(
    tableViewMatches(view, { ...state, visibility: { note: true } }),
    false,
  );
});

test("saving under a known name replaces that view and keeps its id", () => {
  const first = captureTableView("a", "Work", state);
  const views = upsertTableView([], first);
  const replaced = upsertTableView(
    views,
    captureTableView("b", "work", { ...state, query: "new" }),
  );
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].id, "a");
  assert.equal(replaced[0].query, "new");
  assert.equal(findTableViewByName(replaced, " WORK ")?.id, "a");
  assert.equal(findTableViewByName(replaced, "  "), undefined);
  const full = Array.from({ length: TABLE_VIEW_LIMIT }, (_, i) =>
    captureTableView(`v${i}`, `View ${i}`, state),
  );
  assert.equal(
    upsertTableView(full, captureTableView("n", "New", state)),
    null,
  );
  assert.equal(
    upsertTableView(full, captureTableView("n", "View 3", state))?.length,
    TABLE_VIEW_LIMIT,
  );
});

test("filters the table no longer offers are dropped", () => {
  assert.deepEqual(
    pruneTableViewFilters(
      { tag: ["gone", "work"], proxy: ["p1"], old: ["x"] },
      [
        { id: "tag", options: [{ value: "work" }, { value: "" }] },
        { id: "proxy", options: [{ value: "p2" }] },
      ],
    ),
    { tag: ["work"] },
  );
});

test("columns the saved order does not know take their place by their neighbour", () => {
  assert.deepEqual(
    movableColumnOrder(
      ["name", "tags", "note", "dns"],
      ["dns", "name", "gone", "dns"],
    ),
    ["dns", "name", "tags", "note"],
  );
  assert.deepEqual(movableColumnOrder(["name", "tags"], []), ["name", "tags"]);
});

test("fixed columns keep their slots in the full order", () => {
  assert.deepEqual(
    orderTableColumns(
      ["select", "name", "tags", "note", "actions"],
      ["name", "tags", "note", "missing"],
      ["note", "name"],
    ),
    ["select", "note", "name", "tags", "actions"],
  );
});

test("a column moves past the next listed column and stops at the ends", () => {
  const listed = new Set(["name", "tags", "dns"]);
  const order = ["name", "created_at", "tags", "dns"];
  assert.deepEqual(moveTableColumn(order, "name", 1, listed), [
    "created_at",
    "tags",
    "name",
    "dns",
  ]);
  assert.deepEqual(moveTableColumn(order, "dns", -1, listed), [
    "name",
    "created_at",
    "dns",
    "tags",
  ]);
  assert.equal(moveTableColumn(order, "name", -1, listed), order);
  assert.equal(moveTableColumn(order, "dns", 1, listed), order);
  assert.equal(moveTableColumn(order, "missing", 1, listed), order);
});
