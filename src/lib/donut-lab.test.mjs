import assert from "node:assert/strict";
import test from "node:test";
import {
  addBite,
  bakeDonut,
  CRUMB_GLYPHS,
  CRUMB_RAMP,
  castRay,
  centerLens,
  crumbAlpha,
  DEFAULT_CELL,
  DONUT_SPAN,
  DOUGH_RAMP,
  donutDistance,
  findBiteTarget,
  forEachGlyph,
  forEachRun,
  GLAZE_RAMP,
  GLYPHS,
  identity,
  idleOrientation,
  isEaten,
  KIND_DOUGH,
  KIND_EMPTY,
  KIND_GLAZE,
  KIND_SPRINKLE,
  layoutGrid,
  MAJOR_RADIUS,
  MAX_BITES,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  MINOR_RADIUS,
  materialAt,
  normalAt,
  REVEAL_MS,
  rampFor,
  remainingShare,
  renderFrame,
  revealPose,
  rotationX,
  START_ORIENTATION,
  seededRandom,
  shade,
  spin,
  spinStep,
  sprinkleGlyph,
  stepCrumbs,
  surfaceAt,
  toObject,
  turn,
  viewRay,
} from "./donut-lab.ts";

const VIEW = { width: 600, height: 340 };

function unit(v) {
  const length = Math.hypot(...v);
  return v.map((x) => x / length);
}

test("a fresh donut is whole and bakes the same way every time", () => {
  const a = bakeDonut();
  const b = bakeDonut();
  assert.equal(remainingShare(a), 1);
  assert.ok(a.samples.length / 3 > 1000, "enough points to weigh it");
  assert.ok(a.sprinkles.length > 10);
  assert.deepEqual(a.sprinkles, b.sprinkles);
  assert.equal(isEaten(a), false);
});

test("a ray through the hole misses, and a ray onto the ring hits the glaze", () => {
  const donut = bakeDonut();
  assert.equal(castRay(donut, [0, 3, 0], [0, -1, 0]), null);
  assert.equal(castRay(donut, [0, 0, 3], [0, 0, -1])?.point[2] > 1, true);
  assert.equal(castRay(donut, [3, 3, 3], unit([1, 1, 1])), null);

  const top = castRay(donut, [1, 3, 0], [0, -1, 0]);
  assert.ok(top, "the top of the ring");
  assert.ok(Math.abs(donutDistance(donut, ...top.point)) < 0.05);
  assert.equal(materialAt(donut, top.point).material !== "dough", true);

  const bottom = castRay(donut, [1, -3, 0], [0, 1, 0]);
  assert.ok(bottom);
  assert.equal(materialAt(donut, bottom.point).material, "dough");

  // The view opens on the hole: the middle of the canvas shows no donut.
  assert.equal(
    surfaceAt(donut, START_ORIENTATION, VIEW, VIEW.width / 2, VIEW.height / 2),
    null,
  );
});

test("bites carve the field and reduce the mass", () => {
  const donut = bakeDonut();
  const hit = castRay(donut, [1, 3, 0], [0, -1, 0]);
  const normal = normalAt(donut, hit.point);
  assert.ok(normal[1] > 0.5, "the top faces up");

  addBite(donut, hit.point, normal);
  const afterOne = remainingShare(donut);
  assert.ok(afterOne < 1 && afterOne > 0.8, `one bite leaves ${afterOne}`);
  assert.ok(donutDistance(donut, ...hit.point) > 0, "the bitten point is gone");

  // The wall of the bite shows the inside.
  const wall = castRay(donut, [1, 3, 0], [0, -1, 0]);
  assert.ok(wall, "the ray now lands deeper, inside the bite");
  assert.ok(wall.point[1] < hit.point[1]);
  assert.equal(materialAt(donut, wall.point).material, "crumb");

  const other = castRay(donut, [-1, 3, 0], [0, -1, 0]);
  addBite(donut, other.point, normalAt(donut, other.point));
  assert.ok(remainingShare(donut) < afterOne);
});

test("a growing bite carves less and does not count until it is whole", () => {
  const donut = bakeDonut();
  const hit = castRay(donut, [0, 0, 3], [0, 0, -1]);
  const bite = addBite(donut, hit.point, normalAt(donut, hit.point), 0);
  assert.ok(donutDistance(donut, ...hit.point) < 0.02);
  bite.grow = 1;
  assert.ok(donutDistance(donut, ...hit.point) > 0.3);
});

test("the donut is eaten after enough bites, and never takes more than the cap", () => {
  const donut = bakeDonut();
  const random = seededRandom(11);
  let m = START_ORIENTATION;
  for (let tries = 0; tries < 400 && !isEaten(donut); tries++) {
    m = turn(m, (random() - 0.5) * 2, (random() - 0.5) * 4);
    const target = findBiteTarget(
      donut,
      m,
      VIEW,
      random() * VIEW.width,
      random() * VIEW.height,
      40,
    );
    if (target) addBite(donut, target.point, target.normal);
  }
  assert.equal(isEaten(donut), true);
  assert.ok(donut.bites.length <= MAX_BITES);
  assert.ok(donut.bites.length >= 6, "a donut is more than a few bites");
  assert.ok(remainingShare(donut) < 0.5);

  const capped = bakeDonut();
  for (let i = 0; i < MAX_BITES; i++) {
    capped.bites.push({ center: [9, 9, 9], radius: 0.1, grow: 1 });
  }
  assert.equal(remainingShare(capped), 1);
  assert.equal(isEaten(capped), true, "the cap ends a donut that will not go");
});

test("a press in the hole bites the nearest rim, and a press far away bites nothing", () => {
  const donut = bakeDonut();
  const cx = VIEW.width / 2;
  const cy = VIEW.height / 2;
  assert.equal(findBiteTarget(donut, START_ORIENTATION, VIEW, cx, cy, 0), null);
  const rim = findBiteTarget(donut, START_ORIENTATION, VIEW, cx, cy, 120);
  assert.ok(rim);
  assert.ok(Math.hypot(rim.x - cx, rim.y - cy) <= 120);
  assert.equal(findBiteTarget(donut, START_ORIENTATION, VIEW, 2, 2, 20), null);
});

test("shading stays in the ramp of the material and never blanks a hit", () => {
  const random = seededRandom(5);
  assert.equal(rampFor("dough"), DOUGH_RAMP);
  assert.equal(rampFor("glaze"), GLAZE_RAMP);
  assert.equal(rampFor("crumb"), CRUMB_RAMP);
  for (let i = 0; i < 2000; i++) {
    const normal = unit([random() - 0.5, random() - 0.5, random() - 0.5]);
    const toEye = unit([random() - 0.5, random() - 0.5, random() + 0.2]);
    for (const material of ["dough", "glaze", "crumb"]) {
      for (const ink of [false, true]) {
        const char = shade(normal, toEye, material, ink, random() * 2 - 1);
        assert.ok(rampFor(material).includes(char), `${material} ${char}`);
        assert.notEqual(char, " ");
      }
    }
  }
  // Light reads the right way round on both backgrounds.
  const lit = unit([-0.45, 0.7, 0.55]);
  const away = unit([0.45, -0.7, 0.55]);
  const eye = [0, 0, 1];
  const level = (char) => DOUGH_RAMP.indexOf(char);
  assert.ok(
    level(shade(lit, eye, "dough", false)) >
      level(shade(away, eye, "dough", false)),
    "on dark, light is dense",
  );
  assert.ok(
    level(shade(lit, eye, "dough", true)) <
      level(shade(away, eye, "dough", true)),
    "on light, shadow is dense",
  );
});

test("sprinkles draw along their length", () => {
  assert.equal(sprinkleGlyph([1, 0, 0]), "-");
  assert.equal(sprinkleGlyph([0, 1, 0]), "|");
  assert.equal(sprinkleGlyph(unit([1, 1, 0])), "/");
  assert.equal(sprinkleGlyph(unit([-1, 1, 0])), "\\");
  assert.equal(sprinkleGlyph([0, 0, 1]), "o");
});

test("turns and spins stay rotations", () => {
  let m = identity();
  for (let i = 0; i < 500; i++) {
    m = spin(turn(m, 0.07, -0.05), 0.03);
  }
  const rows = [m.slice(0, 3), m.slice(3, 6), m.slice(6, 9)];
  for (const [i, row] of rows.entries()) {
    assert.ok(Math.abs(Math.hypot(...row) - 1) < 1e-9);
    for (const other of rows.slice(i + 1)) {
      const dot = row[0] * other[0] + row[1] * other[1] + row[2] * other[2];
      assert.ok(Math.abs(dot) < 1e-9);
    }
  }
});

test("a frame shows glaze, dough and sprinkles around an empty hole", () => {
  const donut = bakeDonut();
  const { grid, fontSize } = layoutGrid(VIEW.width, VIEW.height);
  assert.ok(grid.cols >= 48 && grid.rows >= 20);
  assert.ok(fontSize >= MIN_FONT_SIZE && fontSize <= MAX_FONT_SIZE);
  const frame = renderFrame(donut, START_ORIENTATION, grid, false);
  const count = (predicate) => frame.kinds.filter(predicate).length;
  assert.ok(count((kind) => kind === KIND_GLAZE) > 100);
  assert.ok(count((kind) => kind === KIND_DOUGH) > 10);
  assert.ok(count((kind) => kind >= KIND_SPRINKLE) > 10);
  const middle = cellAt(grid, grid.width / 2, grid.height / 2);
  assert.equal(frame.kinds[middle], KIND_EMPTY);
  assert.equal(frame.chars[middle], " ");
  for (const [i, char] of frame.chars.entries()) {
    assert.equal(char === " ", frame.kinds[i] === KIND_EMPTY);
  }
});

// The canvas sizes the lab from these: a narrow dialog and a wide one.
const GRIDS = {
  narrow: { width: 300, height: 220 },
  wide: { width: 640, height: 300 },
};
const GEIST = { advance: 0.6, lineHeight: 1.3, mono: true };
const TALL = { advance: 0.5, lineHeight: 1.7, mono: true };

function cellAt(grid, x, y) {
  const col = Math.floor((x - grid.offsetX) / grid.cellWidth);
  const row = Math.floor((y - grid.offsetY) / grid.cellHeight);
  return row * grid.cols + col;
}

/** Where the canvas draws each glyph: the center of its cell, in pixels. */
function glyphs(frame, grid) {
  const out = [];
  forEachGlyph(frame, grid, (char, x, y, kind) =>
    out.push({ char, x, y, kind }),
  );
  return out;
}

/** The smallest distance from a glyph's ray to the torus's core circle. */
function rayToRing(m, grid, lens, x, y) {
  const ray = viewRay(grid, x, y, lens);
  const origin = toObject(m, ray.origin);
  const dir = toObject(m, ray.dir);
  let best = Number.POSITIVE_INFINITY;
  for (let t = 3; t <= 11; t += 0.004) {
    const px = origin[0] + dir[0] * t;
    const py = origin[1] + dir[1] * t;
    const pz = origin[2] + dir[2] * t;
    const q = Math.hypot(px, pz) - MAJOR_RADIUS;
    best = Math.min(best, Math.hypot(q, py));
  }
  return best;
}

test("the grid is whole cells, centered on the canvas, sized from the measured cell", () => {
  for (const view of [...Object.values(GRIDS), { width: 1360, height: 873 }]) {
    for (const cell of [GEIST, TALL, { advance: 0.92, lineHeight: 1.2 }]) {
      const { grid, fontSize } = layoutGrid(view.width, view.height, cell);
      assert.ok(fontSize >= MIN_FONT_SIZE && fontSize <= MAX_FONT_SIZE);
      assert.ok(Math.abs(grid.cellWidth - fontSize * cell.advance) < 1e-9);
      assert.ok(grid.offsetX >= 0 && grid.offsetX < grid.cellWidth / 2 + 1e-9);
      assert.ok(grid.offsetY >= 0 && grid.offsetY < grid.cellHeight / 2 + 1e-9);
      assert.ok(
        Math.abs(2 * grid.offsetX + grid.cols * grid.cellWidth - view.width) <
          1e-9,
      );
      assert.ok(
        Math.abs(2 * grid.offsetY + grid.rows * grid.cellHeight - view.height) <
          1e-9,
      );
    }
  }
  // A font that failed to load or measure falls back to the default cell.
  const broken = layoutGrid(600, 340, { advance: 0.08, lineHeight: 0 });
  const plain = layoutGrid(600, 340, DEFAULT_CELL);
  assert.deepEqual(broken, plain);
});

test("the donut is drawn in the middle of the canvas at every size and moment", () => {
  const donut = bakeDonut();
  for (const view of Object.values(GRIDS)) {
    for (const cell of [GEIST, TALL]) {
      const { grid } = layoutGrid(view.width, view.height, cell);
      const span = DONUT_SPAN * Math.min(view.width, view.height);
      for (let t = 0; t <= 9; t += 0.37) {
        const drawn = glyphs(
          renderFrame(donut, idleOrientation(t), grid, false),
          grid,
        );
        assert.ok(drawn.length > 150, `a whole donut at t=${t}`);
        const cx = drawn.reduce((sum, g) => sum + g.x, 0) / drawn.length;
        const cy = drawn.reduce((sum, g) => sum + g.y, 0) / drawn.length;
        // Perspective makes the near side a little bigger, nothing more.
        const off = Math.hypot(cx - view.width / 2, cy - view.height / 2);
        assert.ok(
          off < span * 0.07,
          `centroid ${off.toFixed(1)} px off at t=${t}`,
        );
        for (const g of drawn) {
          assert.ok(
            g.x > 0 && g.x < view.width && g.y > 0 && g.y < view.height,
          );
        }
      }
    }
  }
});

test("a face-on donut is round: its cell box has the shape of the measured cell", () => {
  const donut = bakeDonut();
  const faceOn = rotationX(Math.PI / 2);
  for (const view of Object.values(GRIDS)) {
    for (const cell of [GEIST, TALL]) {
      const { grid } = layoutGrid(view.width, view.height, cell);
      const frame = renderFrame(donut, faceOn, grid, false);
      let minCol = Infinity,
        maxCol = -Infinity,
        minRow = Infinity,
        maxRow = -Infinity;
      for (const [i, kind] of frame.kinds.entries()) {
        if (kind === KIND_EMPTY) continue;
        const col = i % grid.cols;
        const row = (i - col) / grid.cols;
        minCol = Math.min(minCol, col);
        maxCol = Math.max(maxCol, col);
        minRow = Math.min(minRow, row);
        maxRow = Math.max(maxRow, row);
      }
      const cols = maxCol - minCol + 1;
      const rows = maxRow - minRow + 1;
      const aspect = grid.cellHeight / grid.cellWidth;
      assert.ok(
        Math.abs(cols / rows - aspect) / aspect < 0.08,
        `${cols}x${rows} cells, cell aspect ${aspect.toFixed(2)}`,
      );
      // The same in pixels: as wide as it is tall, to about one cell.
      assert.ok(
        Math.abs(cols * grid.cellWidth - rows * grid.cellHeight) <=
          1.5 * Math.max(grid.cellWidth, grid.cellHeight),
      );
    }
  }
});

test("no glyph lies outside the donut, and the donut has no gaps", () => {
  const donut = bakeDonut();
  for (const view of Object.values(GRIDS)) {
    const { grid } = layoutGrid(view.width, view.height, GEIST);
    const lens = centerLens(grid);
    for (const t of [0, 0.8, 2.1, 3.5, 5, 7.3]) {
      const m = idleOrientation(t);
      const frame = renderFrame(donut, m, grid, false);
      for (const g of glyphs(frame, grid)) {
        // Tube, glaze and a sprinkle's height, and a ray's graze.
        const reach = rayToRing(m, grid, lens, g.x, g.y);
        assert.ok(
          reach < MINOR_RADIUS + 0.2,
          `'${g.char}' ${reach.toFixed(2)} off the ring`,
        );
      }
      // Every cell whose ray goes well inside the tube is drawn.
      for (let i = 0; i < frame.kinds.length; i++) {
        const col = i % grid.cols;
        const row = (i - col) / grid.cols;
        const x = grid.offsetX + (col + 0.5) * grid.cellWidth;
        const y = grid.offsetY + (row + 0.5) * grid.cellHeight;
        if (rayToRing(m, grid, lens, x, y) < MINOR_RADIUS - 0.08) {
          assert.notEqual(frame.kinds[i], KIND_EMPTY, `a gap at ${col},${row}`);
        }
      }
    }
  }
});

test("runs of a monospace font put every glyph in its own cell", () => {
  const donut = bakeDonut();
  const { grid } = layoutGrid(GRIDS.wide.width, GRIDS.wide.height, GEIST);
  const frame = renderFrame(donut, idleOrientation(1.3), grid, false);
  const fromRuns = [];
  forEachRun(frame, grid, (text, x, y, kind) => {
    [...text].forEach((char, j) => {
      fromRuns.push({ char, x: x + (j + 0.5) * grid.cellWidth, y, kind });
    });
  });
  const sort = (list) => list.sort((a, b) => a.y - b.y || a.x - b.x);
  const expected = sort(glyphs(frame, grid));
  const actual = sort(fromRuns);
  assert.equal(actual.length, expected.length);
  for (const [i, g] of actual.entries()) {
    assert.equal(g.char, expected[i].char);
    assert.equal(g.kind, expected[i].kind);
    assert.ok(Math.abs(g.x - expected[i].x) < 1e-6 && g.y === expected[i].y);
  }
});

test("the reveal comes out of the logo and ends exactly on the frame at rest", () => {
  const donut = bakeDonut();
  const origin = { x: 40, y: 36, size: 56 };
  for (const view of Object.values(GRIDS)) {
    const { grid } = layoutGrid(view.width, view.height, GEIST);
    const m = idleOrientation(REVEAL_MS / 1000);
    const rest = renderFrame(donut, m, grid, false);
    for (const elapsed of [REVEAL_MS, REVEAL_MS + 1, 10_000]) {
      const pose = revealPose(m, grid, origin, elapsed);
      assert.deepEqual(pose.lens, centerLens(grid));
      const frame = renderFrame(
        donut,
        pose.orientation,
        grid,
        false,
        undefined,
        pose.lens,
      );
      assert.deepEqual(frame.chars, rest.chars);
      assert.deepEqual(frame.kinds, rest.kinds);
    }
    assert.deepEqual(revealPose(m, grid, null, 0).lens, centerLens(grid));

    // The first frame is already a donut, small, on the logo.
    const first = revealPose(m, grid, origin, 0);
    const start = glyphs(
      renderFrame(donut, first.orientation, grid, false, undefined, first.lens),
      grid,
    );
    assert.ok(start.length > 8 && start.length < glyphs(rest, grid).length / 4);
    const cx = start.reduce((sum, g) => sum + g.x, 0) / start.length;
    const cy = start.reduce((sum, g) => sum + g.y, 0) / start.length;
    assert.ok(Math.hypot(cx - origin.x, cy - origin.y) < 30);

    // On the way it only grows and moves toward the middle.
    let zoom = 0;
    let distance = Infinity;
    for (let elapsed = 0; elapsed < REVEAL_MS; elapsed += 20) {
      const { lens } = revealPose(m, grid, origin, elapsed);
      const d = Math.hypot(lens.x - grid.width / 2, lens.y - grid.height / 2);
      assert.ok(lens.zoom >= zoom && d <= distance + 1e-9);
      zoom = lens.zoom;
      distance = d;
    }
  }
});

test("the idle spin turns the same at any frame rate", () => {
  for (const fps of [144, 60, 23, 7]) {
    let m = START_ORIENTATION;
    const momentum = { x: 0, y: 0, idle: 1 };
    const steps = Math.round(3 * fps);
    for (let i = 0; i < steps; i++) m = spinStep(m, momentum, 1 / fps);
    const expected = idleOrientation(steps / fps);
    for (let i = 0; i < 9; i++) assert.ok(Math.abs(m[i] - expected[i]) < 1e-9);
  }
  // A constant angular speed: equal times, equal turns.
  const angle = (a, b) =>
    Math.acos(
      Math.min(
        1,
        (a[0] * b[0] +
          a[1] * b[1] +
          a[2] * b[2] +
          a[3] * b[3] +
          a[4] * b[4] +
          a[5] * b[5] +
          a[6] * b[6] +
          a[7] * b[7] +
          a[8] * b[8] -
          1) /
          2,
      ),
    );
  const turns = [0, 1.5, 3, 4.5].map((t) =>
    angle(idleOrientation(t), idleOrientation(t + 0.1)),
  );
  for (const value of turns) assert.ok(Math.abs(value - turns[0]) < 0.02);
});

test("consecutive frames turn smoothly", () => {
  const donut = bakeDonut();
  for (const view of Object.values(GRIDS)) {
    const { grid } = layoutGrid(view.width, view.height, GEIST);
    let previous = null;
    for (let t = 0; t < 8; t += 1 / 60) {
      const frame = renderFrame(donut, idleOrientation(t), grid, false);
      const drawn = frame.kinds.filter((kind) => kind !== KIND_EMPTY).length;
      if (previous) {
        let changed = 0;
        for (let i = 0; i < frame.kinds.length; i++) {
          if (
            (frame.kinds[i] === KIND_EMPTY) !==
            (previous[i] === KIND_EMPTY)
          ) {
            changed++;
          }
        }
        assert.ok(
          changed / drawn < 0.08,
          `${changed} of ${drawn} cells jump at t=${t.toFixed(2)}`,
        );
      }
      previous = frame.kinds.slice();
    }
  }
});

test("a flick fades back into the idle spin", () => {
  const run = (fps) => {
    let m = START_ORIENTATION;
    const momentum = { x: 6, y: -4, idle: 0 };
    for (let i = 0; i < 4 * fps; i++) m = spinStep(m, momentum, 1 / fps);
    return { m, momentum };
  };
  const fast = run(120);
  const slow = run(30);
  assert.equal(fast.momentum.x, 0);
  assert.equal(fast.momentum.y, 0);
  assert.ok(fast.momentum.idle > 0.99);
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(fast.m[i] - slow.m[i]) < 1e-3);
  // Without the idle spin (reduced motion) the donut comes to rest.
  const momentum = { x: 3, y: 2, idle: 1 };
  let m = START_ORIENTATION;
  for (let i = 0; i < 300; i++) m = spinStep(m, momentum, 1 / 60, false);
  assert.deepEqual(momentum, { x: 0, y: 0, idle: 0 });
  assert.deepEqual(spinStep(m, momentum, 1 / 60, false), m);
});

test("crumbs fall, fade and are gone when their life is over", () => {
  let crumbs = Array.from({ length: 10 }, (_, i) => ({
    x: 100,
    y: 50,
    vx: (i - 5) * 30,
    vy: -200,
    char: CRUMB_GLYPHS[i % CRUMB_GLYPHS.length],
    kind: KIND_DOUGH,
    age: 0,
    life: 1.1 + i * 0.08,
  }));
  let alpha = 1;
  for (let i = 0; i < 60 * 3 && crumbs.length > 0; i++) {
    crumbs = stepCrumbs(crumbs, 1 / 60, 200);
    for (const crumb of crumbs) assert.ok(crumb.y <= 200);
    if (crumbs.length > 0) {
      const last = crumbs[crumbs.length - 1];
      assert.ok(crumbAlpha(last) <= alpha + 1e-9);
      alpha = crumbAlpha(last);
    }
  }
  assert.equal(crumbs.length, 0);
});

test("the lab measures every glyph it draws", () => {
  for (const char of DOUGH_RAMP + GLAZE_RAMP + CRUMB_RAMP + CRUMB_GLYPHS) {
    if (char !== " ") assert.ok(GLYPHS.includes(char), char);
  }
  for (const axis of [
    [1, 0, 0],
    [0, 1, 0],
    unit([1, 1, 0]),
    unit([-1, 1, 0]),
    [0, 0, 1],
  ]) {
    assert.ok(GLYPHS.includes(sprinkleGlyph(axis)));
  }
});
