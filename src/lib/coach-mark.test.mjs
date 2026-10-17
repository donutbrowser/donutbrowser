import assert from "node:assert/strict";
import test from "node:test";
import {
  anchorSelector,
  COACH_ANCHORS,
  isRailAnchor,
  mostlyVisible,
  placeCoachMark,
  visiblePart,
} from "./coach-mark.ts";

const VIEWPORT = { width: 1000, height: 700 };
const CARD = { width: 300, height: 200 };

test("the card takes the preferred side when it fits there", () => {
  const anchor = { x: 400, y: 50, width: 100, height: 30 };
  const placed = placeCoachMark(anchor, CARD, VIEWPORT, { side: "bottom" });
  assert.equal(placed.side, "bottom");
  assert.equal(placed.y, 50 + 30 + 12);
  assert.equal(placed.x, 450 - 150, "centered on the anchor");
  assert.equal(placed.arrow, 150, "the arrow points at the anchor's middle");
  assert.equal(placed.fits, true);
});

test("the card flips to the opposite side at the bottom of the window", () => {
  const anchor = { x: 400, y: 600, width: 100, height: 30 };
  const placed = placeCoachMark(anchor, CARD, VIEWPORT, { side: "bottom" });
  assert.equal(placed.side, "top");
  assert.equal(placed.y, 600 - 12 - 200);
});

test("a rail anchor gets its card on the right, slid down to stay on screen", () => {
  const anchor = { x: 6, y: 20, width: 28, height: 28 };
  const placed = placeCoachMark(anchor, CARD, VIEWPORT, { side: "right" });
  assert.equal(placed.side, "right");
  assert.equal(placed.x, 6 + 28 + 12);
  assert.equal(placed.y, 8, "held inside the margin");
  assert.equal(placed.arrow, 34 - 8, "the arrow still meets the anchor");
});

test("the arrow never runs into a rounded corner", () => {
  const anchor = { x: 990, y: 50, width: 8, height: 20 };
  const placed = placeCoachMark(anchor, CARD, VIEWPORT, {
    side: "bottom",
    arrowInset: 16,
  });
  assert.equal(placed.x, 1000 - 8 - 300);
  assert.equal(placed.arrow, 300 - 16);
});

test("with no room anywhere the card takes the roomiest side and stays on screen", () => {
  const tiny = { width: 320, height: 220 };
  const anchor = { x: 10, y: 10, width: 300, height: 200 };
  const placed = placeCoachMark(anchor, CARD, tiny, { side: "bottom" });
  assert.equal(placed.fits, false);
  assert.ok(placed.x >= 8 && placed.x + CARD.width <= tiny.width);
});

test("an anchor scrolled mostly out of its container does not count", () => {
  const clip = { x: 0, y: 0, width: 200, height: 100 };
  assert.equal(
    mostlyVisible({ x: 10, y: 10, width: 50, height: 20 }, [clip]),
    true,
  );
  assert.equal(
    mostlyVisible({ x: 180, y: 10, width: 50, height: 20 }, [clip]),
    false,
  );
  assert.equal(
    visiblePart({ x: 300, y: 0, width: 10, height: 10 }, [clip]),
    null,
  );
  assert.deepEqual(
    visiblePart({ x: 190, y: 90, width: 20, height: 20 }, [clip]),
    {
      x: 190,
      y: 90,
      width: 10,
      height: 10,
    },
  );
});

test("anchor ids are unique and map to their attribute", () => {
  assert.equal(new Set(COACH_ANCHORS).size, COACH_ANCHORS.length);
  assert.equal(anchorSelector("rail-more"), '[data-tip-anchor="rail-more"]');
  assert.ok(isRailAnchor("rail-settings"));
  assert.ok(!isRailAnchor("column-dns"));
});
