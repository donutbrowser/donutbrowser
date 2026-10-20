import assert from "node:assert/strict";
import test from "node:test";
import {
  anchorSelector,
  COACH_ANCHORS,
  clipArea,
  isRailAnchor,
  mostlyVisible,
  pickAnchor,
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

const NONE = { top: 0, right: 0, bottom: 0, left: 0 };

test("a scroll container shows its content inside borders, scrollbars and covered edges", () => {
  const border = { x: 100, y: 50, width: 400, height: 300 };
  // A 1px border all round and a 12px scrollbar on the right.
  const client = { left: 1, top: 1, width: 386, height: 298 };
  assert.deepEqual(clipArea(border, client, NONE), {
    x: 101,
    y: 51,
    width: 386,
    height: 298,
  });
  // A 32px sticky header and a 24px fade band at each end.
  assert.deepEqual(
    clipArea(border, client, { top: 56, right: 0, bottom: 24, left: 0 }),
    { x: 101, y: 107, width: 386, height: 218 },
  );
  assert.deepEqual(
    clipArea(border, { left: 0, top: 0, width: 0, height: 0 }, NONE),
    border,
    "an inline element clips at its border box",
  );
});

test("a row under the sticky header or in the fade band does not count", () => {
  const table = clipArea(
    { x: 0, y: 100, width: 600, height: 400 },
    { left: 0, top: 0, width: 600, height: 400 },
    { top: 56, right: 0, bottom: 24, left: 0 },
  );
  const clips = [{ x: 0, y: 0, width: 1000, height: 700 }, table];
  const button = (y) => ({ x: 560, y, width: 28, height: 28 });
  assert.equal(mostlyVisible(button(104), clips), false, "under the header");
  assert.equal(mostlyVisible(button(140), clips), false, "in the fade band");
  assert.equal(mostlyVisible(button(170), clips), true);
  assert.equal(mostlyVisible(button(460), clips), false, "in the bottom fade");
  assert.equal(mostlyVisible(button(800), clips), false, "off the window");
});

/** One info button per row, 36px apart, from the top of the table. */
function rows(count, top = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: "row-inspect",
    item: `row-${index}`,
    box: { x: 560, y: top + index * 36, width: 28, height: 28 },
  }));
}
const RAIL = {
  id: "rail-profiles",
  item: "rail",
  box: { x: 6, y: 60, width: 28, height: 28 },
};
const insideTable = (candidate) =>
  candidate.id !== "row-inspect" ||
  (candidate.box.y >= 156 && candidate.box.y + candidate.box.height <= 600);

test("the first anchor that shows wins, best first, in page order", () => {
  const candidates = [...rows(20, 100), RAIL];
  const found = pickAnchor(
    ["row-inspect", "rail-profiles"],
    candidates,
    insideTable,
    () => undefined,
  );
  assert.equal(found.item, "row-2", "rows 0 and 1 are under the header");
  assert.equal(
    pickAnchor(
      ["row-inspect", "rail-profiles"],
      [...rows(20, 1000), RAIL],
      insideTable,
      () => undefined,
    ).item,
    "rail",
    "with every row scrolled away, the rail item takes the mark",
  );
  assert.equal(
    pickAnchor(["column-dns"], candidates, insideTable, () => undefined),
    null,
    "with no anchor at all there is nowhere to point",
  );
});

test("the followed row keeps the mark while it shows, and the nearest row takes over", () => {
  const anchors = ["row-inspect", "rail-profiles"];
  const at = (item, y) => ({ item, box: { x: 560, y, width: 28, height: 28 } });
  // A short scroll: row 8 moved but still shows, so the mark stays on it.
  assert.equal(
    pickAnchor(anchors, [...rows(20, 0), RAIL], insideTable, () =>
      at("row-8", 388),
    ).item,
    "row-8",
  );
  // Scrolled down: row 8 went under the header, or unmounted. The row
  // nearest to where it was takes the mark, not the first row that shows.
  const down = [...rows(40, -300), RAIL];
  assert.equal(
    pickAnchor(anchors, down, insideTable, () => at("row-8", 160)).item,
    "row-13",
  );
  assert.equal(
    pickAnchor(
      anchors,
      down.filter((candidate) => candidate.item !== "row-8"),
      insideTable,
      () => at("row-8", 160),
    ).item,
    "row-13",
  );
  // Scrolled up: row 8 left at the bottom, and the row above it takes over.
  assert.equal(
    pickAnchor(anchors, [...rows(40, 300), RAIL], insideTable, () =>
      at("row-8", 570),
    ).item,
    "row-7",
  );
});

test("the card stays inside the part of its scroll container that shows", () => {
  const area = { x: 200, y: 156, width: 600, height: 420 };
  const anchor = { x: 760, y: 170, width: 36, height: 36 };
  const placed = placeCoachMark(anchor, CARD, area, { side: "bottom" });
  assert.equal(placed.fits, true);
  assert.equal(placed.side, "bottom");
  assert.ok(
    placed.x >= area.x + 8 && placed.x + CARD.width <= area.x + area.width - 8,
  );
  assert.ok(placed.y + CARD.height <= area.y + area.height - 8);
  // Near the bottom of the table it flips above, still inside.
  const low = { x: 400, y: 520, width: 36, height: 36 };
  const flipped = placeCoachMark(low, CARD, area, { side: "bottom" });
  assert.equal(flipped.side, "top");
  assert.ok(flipped.y >= area.y + 8);
});

test("a card that fits never covers its anchor", () => {
  const area = { x: 200, y: 156, width: 600, height: 420 };
  const overlaps = (a, b) =>
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height;
  for (let y = 160; y <= 540; y += 20) {
    for (let x = 204; x <= 760; x += 37) {
      const anchor = { x, y, width: 36, height: 36 };
      for (const side of ["top", "right", "bottom", "left"]) {
        const placed = placeCoachMark(anchor, CARD, area, { side });
        if (!placed.fits) continue;
        assert.ok(
          !overlaps(anchor, { ...CARD, x: placed.x, y: placed.y }),
          `anchor ${x},${y} preferring ${side}`,
        );
      }
    }
  }
});

test("a container too small for the card does not count as room", () => {
  const strip = { x: 0, y: 0, width: 56, height: 700 };
  const rail = { x: 14, y: 300, width: 28, height: 28 };
  assert.equal(
    placeCoachMark(rail, CARD, strip, { side: "right" }).fits,
    false,
    "the rail is narrower than the card, so the window places it",
  );
  const short = { x: 0, y: 0, width: 1000, height: 150 };
  const head = { x: 400, y: 10, width: 100, height: 30 };
  assert.equal(
    placeCoachMark(head, CARD, short, { side: "right" }).fits,
    false,
    "beside the anchor, the card must also fit the area's height",
  );
});

test("anchor ids are unique and map to their attribute", () => {
  assert.equal(new Set(COACH_ANCHORS).size, COACH_ANCHORS.length);
  assert.equal(anchorSelector("rail-more"), '[data-tip-anchor="rail-more"]');
  assert.ok(isRailAnchor("rail-settings"));
  assert.ok(!isRailAnchor("column-dns"));
});

test("the element a mark started on takes it back when it shows again", () => {
  const box = (top) => ({ x: 0, y: top, width: 20, height: 20 });
  const rows = [1, 2, 3].map((n) => ({
    id: "profile-info",
    item: `row-${n}`,
    box: box(n * 40),
  }));
  const shows = () => true;
  const followed = { item: "row-3", box: box(120) };
  assert.equal(
    pickAnchor(["profile-info"], rows, shows, () => followed).item,
    "row-3",
    "without a home the followed row keeps the mark",
  );
  assert.equal(
    pickAnchor(
      ["profile-info"],
      rows,
      shows,
      () => followed,
      (candidate) => candidate.item === "row-1",
    ).item,
    "row-1",
  );
  assert.equal(
    pickAnchor(
      ["profile-info"],
      rows,
      (candidate) => candidate.item !== "row-1",
      () => followed,
      (candidate) => candidate.item === "row-1",
    ).item,
    "row-3",
    "a home out of view does not take the mark",
  );
});
