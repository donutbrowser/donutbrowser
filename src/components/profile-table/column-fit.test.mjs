import assert from "node:assert/strict";
import test from "node:test";
import { fitColumns } from "./column-fit.ts";

const COLUMNS = [
  { id: "profileId", floor: 100, pct: 0 },
  { id: "dns", floor: 95, pct: 0.11 },
  { id: "ext", floor: 95, pct: 0.11 },
  { id: "note", floor: 80, pct: 0.1 },
  { id: "state", floor: 90, pct: 0.1 },
  { id: "tags", floor: 100, pct: 0.12 },
  { id: "proxy", floor: 110, pct: 0.13, pinned: true },
];

test("the name keeps 220 px in the default 880 px window", () => {
  const fit = fitColumns(800, 132, COLUMNS, 220);
  assert.ok(fit.nameWidth >= 220, `name keeps ${fit.nameWidth}`);
  assert.equal(fit.visible.profileId, false, "the id leaves first");
  assert.equal(fit.visible.proxy, true);
});

test("columns leave in the given order", () => {
  const fit = fitColumns(640, 132, COLUMNS, 220);
  const hidden = COLUMNS.filter((column) => !fit.visible[column.id]).map(
    (column) => column.id,
  );
  assert.deepEqual(
    hidden,
    COLUMNS.slice(0, hidden.length).map((c) => c.id),
  );
  assert.ok(fit.nameWidth >= 220);
});

test("a wide table shows every column at its proportional width", () => {
  const fit = fitColumns(2400, 132, COLUMNS, 220);
  assert.ok(Object.values(fit.visible).every(Boolean));
  assert.equal(fit.widths.tags, Math.round(2400 * 0.12));
});

test("columns shrink toward their floor before any leaves", () => {
  const all = COLUMNS.reduce((sum, column) => sum + column.floor, 0);
  const fit = fitColumns(132 + 220 + all + 40, 132, COLUMNS, 220);
  assert.ok(Object.values(fit.visible).every(Boolean));
  assert.equal(fit.nameWidth, 220);
});

test("pinned columns stay even when the name cannot keep its minimum", () => {
  const fit = fitColumns(300, 132, COLUMNS, 220);
  assert.equal(fit.visible.proxy, true);
  assert.equal(fit.widths.proxy, 110);
});
