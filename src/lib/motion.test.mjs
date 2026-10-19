import assert from "node:assert/strict";
import test from "node:test";
import { originToward, tabDirection } from "./motion.ts";

const ORDER = ["general", "network", "cookies"];

test("a tab after the current one travels forward", () => {
  assert.equal(tabDirection(ORDER, "general", "cookies"), 1);
  assert.equal(tabDirection(ORDER, "network", "cookies"), 1);
});

test("a tab before the current one travels back", () => {
  assert.equal(tabDirection(ORDER, "cookies", "general"), -1);
  assert.equal(tabDirection(ORDER, "network", "general"), -1);
});

test("an unknown or missing tab travels forward", () => {
  assert.equal(tabDirection(ORDER, undefined, "network"), 1);
  assert.equal(tabDirection(ORDER, "network", "removed"), 1);
  assert.equal(tabDirection([], "a", "b"), 1);
});

const BOX = { x: 100, y: 200, width: 400, height: 300 };

test("the origin points at the opener inside the box", () => {
  const opener = { x: 180, y: 260, width: 40, height: 20 };
  assert.equal(originToward(opener, BOX), "100px 70px");
});

test("an opener outside the box clamps the origin to the nearest edge", () => {
  assert.equal(
    originToward({ x: 0, y: 0, width: 20, height: 20 }, BOX),
    "0px 0px",
  );
  assert.equal(
    originToward({ x: 900, y: 900, width: 20, height: 20 }, BOX),
    "400px 300px",
  );
  assert.equal(
    originToward({ x: 290, y: 20, width: 20, height: 20 }, BOX),
    "200px 0px",
  );
});

test("no opener, an empty opener or an empty box gives the center", () => {
  assert.equal(originToward(null, BOX), "50% 50%");
  assert.equal(
    originToward({ x: 10, y: 10, width: 0, height: 0 }, BOX),
    "50% 50%",
  );
  assert.equal(
    originToward(
      { x: 10, y: 10, width: 10, height: 10 },
      { x: 0, y: 0, width: 0, height: 0 },
    ),
    "50% 50%",
  );
});
