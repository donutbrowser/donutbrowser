/**
 * The donut of the About easter egg: a signed distance field, a ray marcher,
 * bites carved out of the field, a mass estimate, text shading, the character
 * grid, and the motion (reveal, idle spin, flick, crumbs) as functions of
 * time. Pure math, so it runs in node tests; the canvas lives in
 * `donut-lab.tsx` and only paints what this module computes.
 *
 * Object space: the ring lies in the XZ plane around the Y axis, and +Y is the
 * glazed top. View space: +X right, +Y up, the camera on +Z looking at the
 * origin. A row-major rotation matrix turns object space into view space.
 * Rays go through canvas pixels with one scale on both axes, so the donut is
 * round whatever the shape of a character cell.
 */

export type Vec3 = [number, number, number];
export type Mat3 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const MAJOR_RADIUS = 1;
export const MINOR_RADIUS = 0.45;
export const GLAZE_THICKNESS = 0.06;
/** Every point of the donut, sprinkles included, lies inside this sphere. */
export const BOUNDS_RADIUS = 1.62;
export const MAX_STEPS = 56;
const SLAB_BOTTOM = -MINOR_RADIUS - 0.02;
const SLAB_TOP = MINOR_RADIUS + GLAZE_THICKNESS + 0.08;
const HIT_DISTANCE = 0.01;
const GRAZE_DISTANCE = 0.05;
export const BITE_RADIUS = 0.8;
/** How far outside the surface a bite's sphere sits: a scoop, not a crater. */
const BITE_OFFSET = 0.1;
const BITE_SMOOTHING = 0.06;
/** The donut is gone when this share of it is eaten, or after this many bites. */
export const EATEN_SHARE = 0.85;
export const MAX_BITES = 30;
const CAMERA_DISTANCE = 7;
/** Half the side of the view, in object units, at the smaller canvas side. */
const FRAME_RADIUS = 1.72;

export const DOUGH_RAMP = " .:-=+*#%@";
export const GLAZE_RAMP = " .,~;oO08@";
export const CRUMB_RAMP = " .,:;io0&@";
export const SPRINKLE_GLYPHS = "-/|\\o";
/** The glyphs of the crumbs that fly off a bite. */
export const CRUMB_GLYPHS = ".,'`:;*";
/** Every glyph the lab draws: the widest sets the width of a cell. */
export const GLYPHS = [
  ...new Set(
    DOUGH_RAMP + GLAZE_RAMP + CRUMB_RAMP + SPRINKLE_GLYPHS + CRUMB_GLYPHS,
  ),
]
  .filter((char) => char !== " ")
  .join("");
export const SPRINKLE_COLORS = 5;

export type Material = "dough" | "glaze" | "crumb" | "sprinkle";

export const KIND_EMPTY = 0;
export const KIND_DOUGH = 1;
export const KIND_GLAZE = 2;
export const KIND_CRUMB = 3;
/** Sprinkles are KIND_SPRINKLE + their color index (0 to 4). */
export const KIND_SPRINKLE = 4;

export interface Sprinkle {
  a: Vec3;
  /** b - a, the capsule's segment. */
  ab: Vec3;
  abLengthSquared: number;
  axis: Vec3;
  color: number;
}

export interface Bite {
  center: Vec3;
  radius: number;
  /** 0 to 1 while the bite is drawn in; the mass estimate ignores it. */
  grow: number;
}

export interface Donut {
  sprinkles: Sprinkle[];
  /** Sprinkle indices by angle around the ring, so a lookup checks a few. */
  buckets: number[][];
  bites: Bite[];
  /** Points inside the fresh donut, xyz packed, for the mass estimate. */
  samples: Float64Array;
}

const SPRINKLE_COUNT = 32;
const SPRINKLE_HALF_LENGTH = 0.1;
const SPRINKLE_RADIUS = 0.035;
/** A hit this close to a sprinkle takes its color: sprinkles stay visible at text resolution. */
const SPRINKLE_HALO = 0.035;
const BUCKETS = 24;
const MASS_SAMPLES = 6000;
const TAU = Math.PI * 2;

/** A small seeded generator, so a donut always bakes the same way. */
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The height on the tube above which the glaze covers it: wavy, as if poured. */
export function glazeEdge(theta: number) {
  return (
    0.18 + 0.06 * Math.sin(5 * theta + 0.6) + 0.03 * Math.sin(11 * theta + 2.1)
  );
}

function bucketOf(theta: number) {
  const turn = (((theta % TAU) + TAU) % TAU) / TAU;
  return Math.min(BUCKETS - 1, Math.floor(turn * BUCKETS));
}

function bakeSprinkles(random: () => number) {
  const sprinkles: Sprinkle[] = [];
  const buckets: number[][] = Array.from({ length: BUCKETS }, () => []);
  const surface = MINOR_RADIUS + GLAZE_THICKNESS - 0.01;
  let guard = 0;
  while (sprinkles.length < SPRINKLE_COUNT && guard++ < 10_000) {
    const theta = random() * TAU;
    const phi = Math.PI * (0.1 + random() * 0.8);
    const y = surface * Math.sin(phi);
    if (y < glazeEdge(theta) + 0.08) continue;
    const rho = MAJOR_RADIUS + surface * Math.cos(phi);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const center: Vec3 = [rho * cos, y, rho * sin];
    // Two tangents of the surface: along the ring, and around the tube.
    const along: Vec3 = [-sin, 0, cos];
    const around: Vec3 = [
      -Math.sin(phi) * cos,
      Math.cos(phi),
      -Math.sin(phi) * sin,
    ];
    const psi = random() * Math.PI;
    const axis: Vec3 = [
      Math.cos(psi) * along[0] + Math.sin(psi) * around[0],
      Math.cos(psi) * along[1] + Math.sin(psi) * around[1],
      Math.cos(psi) * along[2] + Math.sin(psi) * around[2],
    ];
    const a: Vec3 = [
      center[0] - axis[0] * SPRINKLE_HALF_LENGTH,
      center[1] - axis[1] * SPRINKLE_HALF_LENGTH,
      center[2] - axis[2] * SPRINKLE_HALF_LENGTH,
    ];
    const ab: Vec3 = [
      axis[0] * 2 * SPRINKLE_HALF_LENGTH,
      axis[1] * 2 * SPRINKLE_HALF_LENGTH,
      axis[2] * 2 * SPRINKLE_HALF_LENGTH,
    ];
    const index = sprinkles.length;
    sprinkles.push({
      a,
      ab,
      abLengthSquared: (2 * SPRINKLE_HALF_LENGTH) ** 2,
      axis,
      color: index % SPRINKLE_COLORS,
    });
    // Every bucket the sprinkle (and the band where it matters) reaches.
    const reach =
      (SPRINKLE_HALF_LENGTH + SPRINKLE_RADIUS + 0.3) / Math.max(rho, 0.3);
    const steps = Math.ceil((reach / TAU) * BUCKETS) + 1;
    const home = bucketOf(theta);
    for (let step = -steps; step <= steps; step++) {
      const bucket = (home + step + BUCKETS) % BUCKETS;
      if (!buckets[bucket].includes(index)) buckets[bucket].push(index);
    }
  }
  return { sprinkles, buckets };
}

/** Distance to the dough and to the glaze, ignoring bites and sprinkles. */
function bodyParts(x: number, y: number, z: number) {
  const rho = Math.sqrt(x * x + z * z);
  const q = rho - MAJOR_RADIUS;
  const tube = Math.sqrt(q * q + y * y);
  const dough = tube - MINOR_RADIUS;
  const glaze = Math.max(
    tube - MINOR_RADIUS - GLAZE_THICKNESS,
    glazeEdge(Math.atan2(z, x)) - y,
  );
  return { dough, glaze };
}

function sprinkleDistance(
  donut: Donut,
  x: number,
  y: number,
  z: number,
  theta: number,
) {
  let best = Number.POSITIVE_INFINITY;
  let index = -1;
  for (const i of donut.buckets[bucketOf(theta)]) {
    const s = donut.sprinkles[i];
    const px = x - s.a[0];
    const py = y - s.a[1];
    const pz = z - s.a[2];
    let h = (px * s.ab[0] + py * s.ab[1] + pz * s.ab[2]) / s.abLengthSquared;
    h = h < 0 ? 0 : h > 1 ? 1 : h;
    const dx = px - s.ab[0] * h;
    const dy = py - s.ab[1] * h;
    const dz = pz - s.ab[2] * h;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - SPRINKLE_RADIUS;
    if (d < best) {
      best = d;
      index = i;
    }
  }
  return { distance: best, index };
}

function baseDistance(donut: Donut, x: number, y: number, z: number) {
  const rho = Math.sqrt(x * x + z * z);
  const q = rho - MAJOR_RADIUS;
  const tube = Math.sqrt(q * q + y * y);
  const dough = tube - MINOR_RADIUS;
  const theta = Math.atan2(z, x);
  const glaze = Math.max(
    tube - MINOR_RADIUS - GLAZE_THICKNESS,
    glazeEdge(theta) - y,
  );
  let d = dough < glaze ? dough : glaze;
  if (glaze < 0.25) {
    const sprinkle = sprinkleDistance(donut, x, y, z, theta).distance;
    if (sprinkle < d) d = sprinkle;
  }
  return d;
}

/** `d` with a sphere carved out of it, the cut edge slightly rounded. */
export function smoothSubtract(sphere: number, d: number, k: number) {
  const h = Math.min(1, Math.max(0, 0.5 - (0.5 * (d + sphere)) / k));
  return d + (-sphere - d) * h + k * h * (1 - h);
}

/** The signed distance from a point to the donut as it is now, bites included. */
export function donutDistance(donut: Donut, x: number, y: number, z: number) {
  let d = baseDistance(donut, x, y, z);
  for (const bite of donut.bites) {
    const radius = bite.radius * bite.grow;
    if (radius <= 0) continue;
    const bx = x - bite.center[0];
    const by = y - bite.center[1];
    const bz = z - bite.center[2];
    const sphere = Math.sqrt(bx * bx + by * by + bz * bz) - radius;
    // Past the smoothing band a bite leaves the distance as it is.
    if (sphere + d >= BITE_SMOOTHING) continue;
    d = smoothSubtract(sphere, d, BITE_SMOOTHING);
  }
  return d;
}

function bakeSamples(random: () => number) {
  const inside: number[] = [];
  for (let i = 0; i < MASS_SAMPLES; i++) {
    const x = (random() * 2 - 1) * 1.52;
    const y = -0.46 + random() * 0.98;
    const z = (random() * 2 - 1) * 1.52;
    const { dough, glaze } = bodyParts(x, y, z);
    if (Math.min(dough, glaze) <= 0) inside.push(x, y, z);
  }
  return Float64Array.from(inside);
}

/** A fresh donut. The same seed always bakes the same sprinkles. */
export function bakeDonut(seed = 7): Donut {
  const random = seededRandom(seed);
  const { sprinkles, buckets } = bakeSprinkles(random);
  return { sprinkles, buckets, bites: [], samples: bakeSamples(random) };
}

/** The share of the fresh donut still there, 0 to 1, estimated from sample points. */
export function remainingShare(donut: Donut) {
  const { samples, bites } = donut;
  const total = samples.length / 3;
  if (total === 0) return 0;
  let left = 0;
  for (let i = 0; i < samples.length; i += 3) {
    let eaten = false;
    for (const bite of bites) {
      const dx = samples[i] - bite.center[0];
      const dy = samples[i + 1] - bite.center[1];
      const dz = samples[i + 2] - bite.center[2];
      if (dx * dx + dy * dy + dz * dz < bite.radius * bite.radius) {
        eaten = true;
        break;
      }
    }
    if (!eaten) left++;
  }
  return left / total;
}

export function isEaten(donut: Donut, remaining = remainingShare(donut)) {
  return donut.bites.length >= MAX_BITES || remaining <= 1 - EATEN_SHARE;
}

/**
 * Carves a bite at a surface point. The sphere sits a little outside the
 * surface, along the normal, so the bite is a scoop as wide as a mouth.
 */
export function addBite(
  donut: Donut,
  point: Vec3,
  normal: Vec3,
  grow = 1,
): Bite {
  const bite: Bite = {
    center: [
      point[0] + normal[0] * BITE_OFFSET,
      point[1] + normal[1] * BITE_OFFSET,
      point[2] + normal[2] * BITE_OFFSET,
    ],
    radius: BITE_RADIUS,
    grow,
  };
  donut.bites.push(bite);
  return bite;
}

export interface RayHit {
  t: number;
  point: Vec3;
}

/** Marches a ray (object space, `dir` of length 1) to the donut, or returns null. */
export function castRay(
  donut: Donut,
  origin: Vec3,
  dir: Vec3,
  maxSteps = MAX_STEPS,
): RayHit | null {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  // Rays that miss the bounding sphere cannot hit the donut.
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - BOUNDS_RADIUS * BOUNDS_RADIUS;
  const disc = b * b - c;
  if (disc <= 0) return null;
  const root = Math.sqrt(disc);
  let end = -b + root;
  let t = Math.max(0, -b - root);
  // The donut is also a flat slab: march only the stretch inside it.
  if (Math.abs(dy) > 1e-6) {
    const t0 = (SLAB_BOTTOM - oy) / dy;
    const t1 = (SLAB_TOP - oy) / dy;
    t = Math.max(t, Math.min(t0, t1));
    end = Math.min(end, Math.max(t0, t1));
  } else if (oy < SLAB_BOTTOM || oy > SLAB_TOP) {
    return null;
  }
  if (t > end) return null;
  let d = Number.POSITIVE_INFINITY;
  for (let step = 0; step < maxSteps; step++) {
    d = donutDistance(donut, ox + dx * t, oy + dy * t, oz + dz * t);
    if (d < HIT_DISTANCE) break;
    t += d * 0.9;
    if (t > end) return null;
  }
  // A ray that ran out of steps grazing the surface still counts: at text
  // resolution a cell is wider than the gap.
  if (d > GRAZE_DISTANCE) return null;
  return { t, point: [ox + dx * t, oy + dy * t, oz + dz * t] };
}

/** The outward surface normal at a point, from the field's gradient. */
export function normalAt(donut: Donut, p: Vec3): Vec3 {
  const e = 0.004;
  const [x, y, z] = p;
  const a = donutDistance(donut, x + e, y - e, z - e);
  const b = donutDistance(donut, x - e, y - e, z + e);
  const c = donutDistance(donut, x - e, y + e, z - e);
  const d = donutDistance(donut, x + e, y + e, z + e);
  const nx = a - b - c + d;
  const ny = -a - b + c + d;
  const nz = -a + b - c + d;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return [nx / length, ny / length, nz / length];
}

/** What a surface point is made of, and its sprinkle when it is one. */
export function materialAt(
  donut: Donut,
  p: Vec3,
): { material: Material; sprinkle: number } {
  const [x, y, z] = p;
  const { dough, glaze } = bodyParts(x, y, z);
  const sprinkle = sprinkleDistance(donut, x, y, z, Math.atan2(z, x));
  const onBite = donut.bites.some((bite) => {
    const dx = x - bite.center[0];
    const dy = y - bite.center[1];
    const dz = z - bite.center[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz) < bite.radius + 0.03;
  });
  if (onBite) {
    // The wall of a bite: the cut shows what is inside.
    if (sprinkle.distance < 0) {
      return { material: "sprinkle", sprinkle: sprinkle.index };
    }
    if (dough < -0.012) return { material: "crumb", sprinkle: -1 };
    if (glaze < 0 && dough > 0) return { material: "glaze", sprinkle: -1 };
    return { material: "dough", sprinkle: -1 };
  }
  if (sprinkle.distance < Math.min(dough, glaze) + SPRINKLE_HALO) {
    return { material: "sprinkle", sprinkle: sprinkle.index };
  }
  return { material: glaze < dough ? "glaze" : "dough", sprinkle: -1 };
}

export function rampFor(material: Material) {
  return material === "glaze"
    ? GLAZE_RAMP
    : material === "crumb"
      ? CRUMB_RAMP
      : DOUGH_RAMP;
}

/** The light, in view space: from the upper left, in front. */
export const LIGHT: Vec3 = (() => {
  const v: Vec3 = [-0.45, 0.7, 0.55];
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
})();

/**
 * The character for a surface point, from its view-space normal and the
 * direction to the eye. Lambert light, a rim term and, on the glaze, a
 * highlight. On a dark background dense characters are light. On a light
 * background (`ink`) they are shadow, the rim draws an outline, and the
 * highlight is bare paper. A hit is never blank, so the silhouette holds.
 * `grain` (-1 to 1) roughens the crumb.
 */
export function shade(
  normal: Vec3,
  toEye: Vec3,
  material: Material,
  ink: boolean,
  grain = 0,
): string {
  const ramp = rampFor(material);
  const [nx, ny, nz] = normal;
  const diffuse = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
  const facing = Math.max(0, nx * toEye[0] + ny * toEye[1] + nz * toEye[2]);
  const rim = (1 - facing) ** 2;
  let highlight = 0;
  if (material === "glaze") {
    const hx = LIGHT[0] + toEye[0];
    const hy = LIGHT[1] + toEye[1];
    const hz = LIGHT[2] + toEye[2];
    const length = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
    highlight = Math.max(0, (nx * hx + ny * hy + nz * hz) / length) ** 24;
  }
  const texture = material === "crumb" ? grain * 0.18 : 0;
  const value = ink
    ? 0.12 + 0.7 * (1 - diffuse) + 0.35 * rim - 0.7 * highlight + texture
    : 0.1 + 0.75 * diffuse + 0.35 * rim + 0.6 * highlight + texture;
  const clamped = Math.min(1, Math.max(0, value));
  const level = 1 + Math.round(clamped * (ramp.length - 2));
  return ramp[level];
}

/** The glyph of a sprinkle, drawn along its length as it looks from the eye. */
export function sprinkleGlyph(axisView: Vec3) {
  const [x, y] = axisView;
  if (Math.hypot(x, y) < 0.35) return "o";
  let angle = Math.atan2(y, x);
  if (angle < 0) angle += Math.PI;
  const eighth = Math.PI / 8;
  if (angle < eighth || angle >= 7 * eighth) return "-";
  if (angle < 3 * eighth) return "/";
  if (angle < 5 * eighth) return "|";
  return "\\";
}

export function identity(): Mat3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0) as Mat3;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3] * b[col] +
        a[row * 3 + 1] * b[3 + col] +
        a[row * 3 + 2] * b[6 + col];
    }
  }
  return out;
}

export function rotationX(angle: number): Mat3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

export function rotationY(angle: number): Mat3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

export function rotationZ(angle: number): Mat3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Keeps a matrix a rotation after many small turns. */
export function orthonormalize(m: Mat3): Mat3 {
  const x: Vec3 = [m[0], m[1], m[2]];
  let length = Math.hypot(...x) || 1;
  x[0] /= length;
  x[1] /= length;
  x[2] /= length;
  const yDotX = m[3] * x[0] + m[4] * x[1] + m[5] * x[2];
  const y: Vec3 = [
    m[3] - yDotX * x[0],
    m[4] - yDotX * x[1],
    m[5] - yDotX * x[2],
  ];
  length = Math.hypot(...y) || 1;
  y[0] /= length;
  y[1] /= length;
  y[2] /= length;
  const z: Vec3 = [
    x[1] * y[2] - x[2] * y[1],
    x[2] * y[0] - x[0] * y[2],
    x[0] * y[1] - x[1] * y[0],
  ];
  return [...x, ...y, ...z] as Mat3;
}

/** A rotation by `angle` about a unit axis. */
export function rotationAbout(axis: Vec3, angle: number): Mat3 {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ];
}

/**
 * Turns the donut about the screen's axes, as one turn about their sum: a
 * drag, an arrow key, or a flick.
 */
export function turn(m: Mat3, aroundX: number, aroundY: number): Mat3 {
  const angle = Math.hypot(aroundX, aroundY);
  if (angle === 0) return m;
  return orthonormalize(
    multiply(rotationAbout([aroundX / angle, aroundY / angle, 0], angle), m),
  );
}

/** Spins the donut about its own axis, as a record turns. */
export function spin(m: Mat3, angle: number): Mat3 {
  return orthonormalize(multiply(m, rotationY(angle)));
}

/** Top tilted toward the eye, so the glaze and the hole both show. */
export const START_ORIENTATION: Mat3 = turn(identity(), 0.75, 0);

export function toView(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function toObject(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

/** A canvas, in CSS pixels. */
export interface View {
  width: number;
  height: number;
}

/** Where the donut sits on a canvas: its center in CSS pixels, and its scale. */
export interface Lens {
  x: number;
  y: number;
  zoom: number;
}

/** The donut at rest: in the middle of the canvas, at full size. */
export function centerLens(view: View): Lens {
  return { x: view.width / 2, y: view.height / 2, zoom: 1 };
}

/** Object units per canvas pixel, the same on both axes. */
function unitsPerPixel(view: View, lens: Lens) {
  return (
    (2 * FRAME_RADIUS) /
    (Math.max(1, Math.min(view.width, view.height)) * lens.zoom)
  );
}

/** The ray through a canvas point, in view space. */
export function viewRay(
  view: View,
  px: number,
  py: number,
  lens = centerLens(view),
) {
  const scale = unitsPerPixel(view, lens);
  const x = (px - lens.x) * scale;
  const y = (lens.y - py) * scale;
  const length = Math.sqrt(x * x + y * y + CAMERA_DISTANCE * CAMERA_DISTANCE);
  return {
    origin: [0, 0, CAMERA_DISTANCE] as Vec3,
    dir: [x / length, y / length, -CAMERA_DISTANCE / length] as Vec3,
  };
}

/** Where an object-space point lands on the canvas. */
export function project(view: View, m: Mat3, p: Vec3, lens = centerLens(view)) {
  const [x, y, z] = toView(m, p);
  const scale = unitsPerPixel(view, lens);
  const perspective = CAMERA_DISTANCE / (CAMERA_DISTANCE - z);
  return {
    x: lens.x + (x * perspective) / scale,
    y: lens.y - (y * perspective) / scale,
  };
}

export interface SurfacePoint {
  point: Vec3;
  normal: Vec3;
  /** In view space, to shade it. */
  viewNormal: Vec3;
  toEye: Vec3;
}

/** The donut's surface under a canvas point, or null where the ray misses. */
export function surfaceAt(
  donut: Donut,
  m: Mat3,
  view: View,
  px: number,
  py: number,
  lens = centerLens(view),
): SurfacePoint | null {
  const ray = viewRay(view, px, py, lens);
  const hit = castRay(donut, toObject(m, ray.origin), toObject(m, ray.dir));
  if (!hit) return null;
  const normal = normalAt(donut, hit.point);
  return {
    point: hit.point,
    normal,
    viewNormal: toView(m, normal),
    toEye: [-ray.dir[0], -ray.dir[1], -ray.dir[2]],
  };
}

/**
 * The surface point to bite for a press at a canvas point: under it, or the
 * nearest one within `reach` pixels, so a press in the hole bites its rim.
 */
export function findBiteTarget(
  donut: Donut,
  m: Mat3,
  view: View,
  px: number,
  py: number,
  reach: number,
  lens = centerLens(view),
  step = 6,
): (SurfacePoint & { x: number; y: number }) | null {
  const direct = surfaceAt(donut, m, view, px, py, lens);
  if (direct) return { ...direct, x: px, y: py };
  for (let radius = step; radius <= reach; radius += step) {
    const count = Math.max(8, Math.ceil((TAU * radius) / step));
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * TAU;
      const x = px + Math.cos(angle) * radius;
      const y = py + Math.sin(angle) * radius;
      if (x < 0 || y < 0 || x > view.width || y > view.height) continue;
      const surface = surfaceAt(donut, m, view, x, y, lens);
      if (surface) return { ...surface, x, y };
    }
  }
  return null;
}

/**
 * The shape of a character cell, per pixel of font size, measured from the
 * font the canvas draws with.
 */
export interface CellMetrics {
  /** The advance of the widest glyph the lab draws. */
  advance: number;
  /** Ascent plus descent. */
  lineHeight: number;
  /** Every glyph has the same advance: a run of cells can be one string. */
  mono?: boolean;
}

/** Geist Mono: every glyph 0.6 wide, ascent 1.005, descent 0.295. */
export const DEFAULT_CELL: CellMetrics = { advance: 0.6, lineHeight: 1.3 };
/** Rows sit closer than lines of text: the ink of a glyph is shorter than its line. */
const ROW_PITCH = 0.72;
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 24;
/** Columns across the donut, when the font size allows it. */
export const COLUMNS_ACROSS = 48;
/** The donut's width at rest, as a share of the canvas's smaller side. */
export const DONUT_SPAN =
  (MAJOR_RADIUS + MINOR_RADIUS + GLAZE_THICKNESS) / FRAME_RADIUS;

/** The character grid laid over a canvas. */
export interface Grid extends View {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  offsetX: number;
  offsetY: number;
}

export interface Frame {
  chars: string[];
  kinds: Uint8Array;
}

/**
 * Lays a grid of whole cells over a canvas, centered on it, so the donut is
 * about `across` columns wide. The cell is as wide as the font's widest glyph,
 * and each glyph is drawn at the center of its cell, so the font never moves
 * a glyph.
 */
export function layoutGrid(
  width: number,
  height: number,
  cell: CellMetrics = DEFAULT_CELL,
  across = COLUMNS_ACROSS,
) {
  const advance =
    cell.advance >= 0.3 && cell.advance <= 1.5
      ? cell.advance
      : DEFAULT_CELL.advance;
  const lineHeight =
    cell.lineHeight >= 0.8 && cell.lineHeight <= 2.5
      ? cell.lineHeight
      : DEFAULT_CELL.lineHeight;
  const span = DONUT_SPAN * Math.max(1, Math.min(width, height));
  const fontSize = Math.min(
    MAX_FONT_SIZE,
    Math.max(MIN_FONT_SIZE, span / across / advance),
  );
  const cellWidth = fontSize * advance;
  const cellHeight = fontSize * lineHeight * ROW_PITCH;
  const cols = Math.max(1, Math.floor(width / cellWidth));
  const rows = Math.max(1, Math.floor(height / cellHeight));
  const grid: Grid = {
    width,
    height,
    cols,
    rows,
    cellWidth,
    cellHeight,
    offsetX: (width - cols * cellWidth) / 2,
    offsetY: (height - rows * cellHeight) / 2,
  };
  return { grid, fontSize };
}

function hash3(x: number, y: number, z: number) {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return (n - Math.floor(n)) * 2 - 1;
}

/** Ray marches every cell of the grid into a frame of characters and kinds. */
export function renderFrame(
  donut: Donut,
  m: Mat3,
  grid: Grid,
  ink: boolean,
  reuse?: Frame,
  lens = centerLens(grid),
): Frame {
  const size = grid.cols * grid.rows;
  const frame =
    reuse && reuse.kinds.length === size
      ? reuse
      : {
          chars: new Array<string>(size).fill(" "),
          kinds: new Uint8Array(size),
        };
  for (let row = 0; row < grid.rows; row++) {
    const py = grid.offsetY + (row + 0.5) * grid.cellHeight;
    for (let col = 0; col < grid.cols; col++) {
      const index = row * grid.cols + col;
      const px = grid.offsetX + (col + 0.5) * grid.cellWidth;
      const surface = surfaceAt(donut, m, grid, px, py, lens);
      if (!surface) {
        frame.chars[index] = " ";
        frame.kinds[index] = KIND_EMPTY;
        continue;
      }
      const { material, sprinkle } = materialAt(donut, surface.point);
      if (material === "sprinkle") {
        const { axis, color } = donut.sprinkles[sprinkle];
        frame.chars[index] = sprinkleGlyph(toView(m, axis));
        frame.kinds[index] = KIND_SPRINKLE + color;
        continue;
      }
      const [x, y, z] = surface.point;
      const grain = material === "crumb" ? hash3(x * 9, y * 9, z * 9) : 0;
      frame.chars[index] = shade(
        surface.viewNormal,
        surface.toEye,
        material,
        ink,
        grain,
      );
      frame.kinds[index] =
        material === "glaze"
          ? KIND_GLAZE
          : material === "crumb"
            ? KIND_CRUMB
            : KIND_DOUGH;
    }
  }
  return frame;
}

/**
 * Calls `draw` for every drawn cell (only those of `kind`, when given) with
 * the center of its cell in canvas pixels. The canvas draws each glyph there,
 * centered, so glyphs of every kind and width stay on the grid.
 */
export function forEachGlyph(
  frame: Frame,
  grid: Grid,
  draw: (char: string, x: number, y: number, kind: number) => void,
  kind?: number,
) {
  for (let i = 0; i < frame.kinds.length; i++) {
    const k = frame.kinds[i];
    if (k === KIND_EMPTY || (kind !== undefined && k !== kind)) continue;
    const col = i % grid.cols;
    const row = (i - col) / grid.cols;
    draw(
      frame.chars[i],
      grid.offsetX + (col + 0.5) * grid.cellWidth,
      grid.offsetY + (row + 0.5) * grid.cellHeight,
      k,
    );
  }
}

/**
 * Calls `draw` for every run of adjacent cells of one kind (only `kind`, when
 * given) in a row, with the run's text, the left edge of its first cell and
 * the middle of its row. With a monospace font whose advance is the cell
 * width, a run drawn from its left edge puts each glyph in its own cell, in
 * far fewer draw calls than one per glyph. Spaces are never drawn, so glyphs
 * of other kinds never shift a run.
 */
export function forEachRun(
  frame: Frame,
  grid: Grid,
  draw: (text: string, x: number, y: number, kind: number) => void,
  kind?: number,
) {
  for (let row = 0; row < grid.rows; row++) {
    const start = row * grid.cols;
    const y = grid.offsetY + (row + 0.5) * grid.cellHeight;
    let col = 0;
    while (col < grid.cols) {
      const k = frame.kinds[start + col];
      if (k === KIND_EMPTY || (kind !== undefined && k !== kind)) {
        col++;
        continue;
      }
      let end = col + 1;
      while (end < grid.cols && frame.kinds[start + end] === k) end++;
      draw(
        frame.chars.slice(start + col, start + end).join(""),
        grid.offsetX + col * grid.cellWidth,
        y,
        k,
      );
      col = end;
    }
  }
}

/** The frame as plain text, one line per row. */
export function frameToText(frame: Frame, grid: Grid) {
  const lines: string[] = [];
  for (let row = 0; row < grid.rows; row++) {
    lines.push(
      frame.chars.slice(row * grid.cols, (row + 1) * grid.cols).join(""),
    );
  }
  return lines.join("\n");
}

/**
 * The idle spin, in radians per second: the classic two-axis turn. The donut
 * tumbles about its own X axis while the picture rolls about the line of
 * sight. One turn acts in object space and the other in view space, so they
 * commute: the spin after t seconds is the same at any frame rate.
 */
export const IDLE_TUMBLE = 0.9;
export const IDLE_ROLL = 0.42;

/** Turns the donut by `seconds` of the idle spin at full speed. */
export function idleStep(m: Mat3, seconds: number): Mat3 {
  if (seconds === 0) return m;
  return orthonormalize(
    multiply(
      multiply(rotationZ(IDLE_ROLL * seconds), m),
      rotationX(IDLE_TUMBLE * seconds),
    ),
  );
}

/** The donut `seconds` into the idle spin from `start`. */
export function idleOrientation(seconds: number, start = START_ORIENTATION) {
  return idleStep(start, seconds);
}

/** How fast a flick fades into the idle spin, per second. */
export const SETTLE_RATE = 2.6;
/** The fastest flick, in radians per second. */
export const MAX_FLICK = 9;

/**
 * A flick's speed about the screen's X and Y axes, in radians per second, and
 * the share of the idle spin that runs (0 while a hand holds the donut).
 */
export interface Momentum {
  x: number;
  y: number;
  idle: number;
}

/**
 * Moves the donut `dt` seconds on. The flick fades and the idle spin comes
 * back at the same rate, so a flick hands over to the idle spin with no jump.
 * Each is integrated exactly, and the flick sits between two halves of the
 * idle step, so the turn hardly depends on the frame rate.
 */
export function spinStep(
  m: Mat3,
  momentum: Momentum,
  dt: number,
  idle = true,
): Mat3 {
  if (!(dt > 0)) return m;
  const fade = Math.exp(-SETTLE_RATE * dt);
  const halfFade = Math.exp((-SETTLE_RATE * dt) / 2);
  // Integrals of e^(-k s) over the step and over half of it.
  const share = (1 - fade) / SETTLE_RATE;
  const halfShare = (1 - halfFade) / SETTLE_RATE;
  // The idle share is 1 - (1 - w0) e^(-k s); its integral over each half:
  const lag = idle ? 1 - momentum.idle : 1;
  const firstHalf = idle ? dt / 2 - lag * halfShare : 0;
  const secondHalf = idle ? dt / 2 - lag * halfFade * halfShare : 0;
  let next = idleStep(m, firstHalf);
  if (momentum.x !== 0 || momentum.y !== 0) {
    next = turn(next, momentum.x * share, momentum.y * share);
    momentum.x *= fade;
    momentum.y *= fade;
    if (Math.abs(momentum.x) + Math.abs(momentum.y) < 1e-3) {
      momentum.x = 0;
      momentum.y = 0;
    }
  }
  momentum.idle = idle ? 1 - lag * fade : 0;
  return idleStep(next, secondHalf);
}

/** How long the donut takes to come out of the logo. */
export const REVEAL_MS = 560;
/** The extra tumble of the reveal: the donut flips over once as it lands. */
const REVEAL_TWIST = Math.PI;
/** The smallest scale a reveal starts at, so its first frame is a donut already. */
const REVEAL_MIN_ZOOM = 0.22;

/** Where a reveal starts: the logo's center and size, in canvas pixels. */
export interface RevealOrigin {
  x: number;
  y: number;
  size: number;
}

export interface Pose {
  orientation: Mat3;
  lens: Lens;
}

/**
 * The donut `elapsedMs` into its reveal: it comes out of the logo at the
 * logo's size, moves to the middle as it grows, and flips over once, fast at
 * first. From REVEAL_MS on, and with no origin, it is exactly the pose at rest.
 */
export function revealPose(
  m: Mat3,
  view: View,
  origin: RevealOrigin | null,
  elapsedMs: number,
): Pose {
  const rest = centerLens(view);
  if (!origin || !(elapsedMs < REVEAL_MS))
    return { orientation: m, lens: rest };
  const p = Math.max(0, elapsedMs) / REVEAL_MS;
  const eased = 1 - (1 - p) ** 3;
  const span = DONUT_SPAN * Math.max(1, Math.min(view.width, view.height));
  const startZoom = Math.min(1, Math.max(REVEAL_MIN_ZOOM, origin.size / span));
  return {
    orientation: orthonormalize(
      multiply(m, rotationX(-REVEAL_TWIST * (1 - eased))),
    ),
    lens: {
      x: origin.x + (rest.x - origin.x) * eased,
      y: origin.y + (rest.y - origin.y) * eased,
      zoom: startZoom + (1 - startZoom) * eased,
    },
  };
}

/** A crumb that flies off a bite, in canvas pixels. */
export interface Crumb {
  x: number;
  y: number;
  vx: number;
  vy: number;
  char: string;
  kind: number;
  /** Seconds since the bite, and seconds the crumb lasts. */
  age: number;
  life: number;
}

/** Pixels per second, per second. */
export const CRUMB_GRAVITY = 1100;
/** Seconds a crumb takes to fade out at the end of its life. */
const CRUMB_FADE = 0.4;

/**
 * Moves the crumbs `dt` seconds on, bouncing on `floor`, and returns the ones
 * whose life is not over.
 */
export function stepCrumbs(crumbs: Crumb[], dt: number, floor: number) {
  return crumbs.filter((crumb) => {
    crumb.age += dt;
    crumb.vy += CRUMB_GRAVITY * dt;
    crumb.x += crumb.vx * dt;
    crumb.y += crumb.vy * dt;
    if (crumb.y > floor) {
      crumb.y = floor;
      crumb.vy = Math.abs(crumb.vy) < 60 ? 0 : -crumb.vy * 0.3;
      crumb.vx *= 0.55;
    }
    return crumb.age < crumb.life;
  });
}

export function crumbAlpha(crumb: Crumb) {
  return Math.min(1, Math.max(0, (crumb.life - crumb.age) / CRUMB_FADE));
}
