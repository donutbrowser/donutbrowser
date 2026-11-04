import assert from "node:assert/strict";
import test from "node:test";
import { stepInterfaceZoom } from "./interface-zoom.ts";

test("zoom moves one step and stops at the ends", () => {
  assert.equal(stepInterfaceZoom(100, 1), 110);
  assert.equal(stepInterfaceZoom(100, -1), 90);
  assert.equal(stepInterfaceZoom(150, 1), 150);
  assert.equal(stepInterfaceZoom(80, -1), 80);
  assert.equal(stepInterfaceZoom(125, 0), 100);
});

test("a size between steps moves to the nearest step that way", () => {
  assert.equal(stepInterfaceZoom(105, 1), 110);
  assert.equal(stepInterfaceZoom(105, -1), 100);
  assert.equal(stepInterfaceZoom(200, -1), 150);
  assert.equal(stepInterfaceZoom(50, 1), 80);
});
