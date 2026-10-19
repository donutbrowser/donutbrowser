import assert from "node:assert/strict";
import test from "node:test";
import {
  addBite,
  bakeDonut,
  CRUMB_RAMP,
  castRay,
  DOUGH_RAMP,
  donutDistance,
  findBiteTarget,
  GLAZE_RAMP,
  identity,
  isEaten,
  KIND_DOUGH,
  KIND_EMPTY,
  KIND_GLAZE,
  KIND_SPRINKLE,
  layoutGrid,
  MAX_BITES,
  materialAt,
  normalAt,
  rampFor,
  remainingShare,
  renderFrame,
  START_ORIENTATION,
  seededRandom,
  shade,
  spin,
  sprinkleGlyph,
  surfaceAt,
  turn,
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
  assert.equal(grid.cols, 64);
  assert.ok(grid.rows >= 20 && grid.rows <= 40);
  assert.ok(fontSize > 8);
  const frame = renderFrame(donut, START_ORIENTATION, grid, false);
  const count = (predicate) => frame.kinds.filter(predicate).length;
  assert.ok(count((kind) => kind === KIND_GLAZE) > 100);
  assert.ok(count((kind) => kind === KIND_DOUGH) > 10);
  assert.ok(count((kind) => kind >= KIND_SPRINKLE) > 10);
  const middle =
    Math.floor(grid.rows / 2) * grid.cols + Math.floor(grid.cols / 2);
  assert.equal(frame.kinds[middle], KIND_EMPTY);
  assert.equal(frame.chars[middle], " ");
  for (const [i, char] of frame.chars.entries()) {
    assert.equal(char === " ", frame.kinds[i] === KIND_EMPTY);
  }
});
