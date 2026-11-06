// Records the tip and onboarding clips from a static build of the app with
// a mocked backend and demo data, and writes them to public/clips.
//
//   pnpm clips                  every clip, light and dark
//   pnpm clips groups vpn       only these clips
//   --theme=dark                one theme
//   --no-build                  reuse the last static build
//   --ref=HEAD                  build a commit instead of the working tree
//   --work=DIR                  scratch folder (default: system temp)
//
// Needs Google Chrome, and img2webp, cwebp and ffmpeg on PATH.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CLIPS } from "./clips.mjs";
import { Take } from "./take.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(ROOT, "public/clips");
const FPS = 24;
const THEMES = ["dark", "light"];

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find(
    (arg) => arg === `--${name}` || arg.startsWith(`--${name}=`),
  );
  if (!hit) return undefined;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : true;
};
const wanted = args.filter((arg) => !arg.startsWith("--"));

/** The default scratch folder in the shared temp dir, closed to other users. */
function privateTempDir(name) {
  const dir = path.join(os.tmpdir(), name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return dir;
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) {
    throw new Error(`${dir} is not your own folder; pass --work=DIR`);
  }
  fs.chmodSync(dir, 0o700);
  return dir;
}

const work = path.resolve(flag("work") || privateTempDir("donut-clips"));
const themes = flag("theme") ? [flag("theme")] : THEMES;
for (const id of wanted) {
  if (!CLIPS[id]) throw new Error(`Unknown clip: ${id}`);
}
const ids = wanted.length ? wanted : Object.keys(CLIPS);

function run(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${cmd} failed`);
}

/** Builds the frontend in a copy, so the checkout's own build stays as it is. */
function build() {
  const app = path.join(work, "app");
  const ref = flag("ref");
  fs.rmSync(path.join(app, "src"), { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });
  const paths = [
    "src",
    "public",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "next.config.ts",
    "tsconfig.json",
    "postcss.config.mjs",
  ];
  if (ref) {
    const tar = execFileSync("git", ["archive", ref, "--", ...paths], {
      cwd: ROOT,
      maxBuffer: 1 << 30,
    });
    run("tar", ["-x", "-C", app], {
      input: tar,
      stdio: ["pipe", "inherit", "inherit"],
    });
  } else {
    const files = execFileSync(
      "git",
      [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ...paths,
      ],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 },
    )
      .split("\0")
      .filter((file) => file && !file.startsWith("public/clips/"));
    for (const file of files) {
      const from = path.join(ROOT, file);
      if (!fs.existsSync(from)) continue;
      const to = path.join(app, file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
  fs.rmSync(path.join(app, "public/clips"), { recursive: true, force: true });
  run(
    "pnpm",
    ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
    {
      cwd: app,
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  run(path.join(app, "node_modules/.bin/next"), ["build"], {
    cwd: app,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return path.join(app, "dist");
}

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".webp": "image/webp",
  ".txt": "text/plain",
};

async function serve(dir) {
  const server = http.createServer((req, res) => {
    let file = path.join(
      dir,
      decodeURIComponent(new URL(req.url, "http://x").pathname),
    );
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      file = path.join(file, "index.html");
    }
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
    });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

const hash = (file) =>
  crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");

/**
 * Picks one captured frame per output frame, blends the start of the loop
 * with the frames after its end when the clip fades, and encodes an
 * animated WebP and a still.
 */
function encode({ frames: captured, clip, name }) {
  const length = clip.length;
  const fade = clip.fade ?? 0;
  const fps = clip.fps ?? FPS;
  const count = Math.round((length / 1000) * fps);
  const fadeCount = Math.round((fade / 1000) * fps);
  const pick = (t) => {
    let best = captured[0];
    for (const frame of captured) {
      if (Math.abs(frame.t - t) < Math.abs(best.t - t)) best = frame;
    }
    return best.file;
  };
  const dir = path.join(work, "out", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const t = (i * 1000) / fps;
    const own = pick(t);
    if (i < fadeCount) {
      const blended = path.join(dir, `blend-${i}.png`);
      const weight = (i + 1) / (fadeCount + 1);
      run("ffmpeg", [
        "-loglevel",
        "error",
        "-y",
        "-i",
        pick(t + length),
        "-i",
        own,
        "-filter_complex",
        `[1:v][0:v]blend=all_mode=normal:all_opacity=${weight.toFixed(3)},format=rgb24`,
        blended,
      ]);
      frames.push(blended);
    } else {
      frames.push(own);
    }
  }
  // Repeated frames become one longer frame.
  const runs = [];
  for (const file of frames) {
    const key = hash(file);
    const last = runs.at(-1);
    if (last && last.key === key) last.count += 1;
    else runs.push({ key, file, count: 1 });
  }
  const webp = path.join(OUT, `${name}.webp`);
  const img2webpArgs = [
    "-loop",
    "0",
    ...(clip.webp ?? ["-near_lossless", "60", "-q", "100", "-m", "6"]),
  ];
  for (const item of runs) {
    img2webpArgs.push(
      "-d",
      String(Math.round((item.count * 1000) / fps)),
      item.file,
    );
  }
  img2webpArgs.push("-o", webp);
  run("img2webp", img2webpArgs, { stdio: ["ignore", "ignore", "ignore"] });
  const posterIndex = Math.min(
    count - 1,
    Math.round((clip.poster ?? 0.5) * count),
  );
  const still = path.join(OUT, `${name}-still.webp`);
  run("cwebp", [
    "-quiet",
    "-q",
    "80",
    "-m",
    "6",
    frames[posterIndex],
    "-o",
    still,
  ]);
  return { webp: fs.statSync(webp).size, still: fs.statSync(still).size };
}

const encodeOnly = args.includes("--encode-only");
const dist =
  encodeOnly || args.includes("--no-build")
    ? path.join(work, "app/dist")
    : build();
const { server, url } = await serve(dist);
const browser = encodeOnly
  ? null
  : await chromium.launch({ channel: "chrome", headless: true });
fs.mkdirSync(OUT, { recursive: true });
const totals = [];
const failed = [];

/** Records one take and returns its frames, each with its virtual time. */
async function record(clip, name, theme) {
  const viewport = clip.viewport || { width: 720, height: 450 };
  const output = clip.output || { width: 800, height: 400 };
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion: "no-preference",
  });
  const demo = { ...(clip.demo || {}), theme };
  await context.addInitScript({
    content: `window.__CLIP_DEMO__ = ${JSON.stringify(demo)};`,
  });
  await context.addInitScript({ path: path.join(HERE, "demo-data.js") });
  await context.addInitScript({ path: path.join(HERE, "page-init.js") });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForSelector(clip.ready || "tbody tr");
  await page.waitForTimeout(800);
  // The app takes the first click after it loads for itself; give it one on
  // a label, so the take's first click lands.
  await page
    .getByText(/of \d+ rows/)
    .first()
    .click();
  await page.waitForTimeout(200);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Animation.enable");
  const framesDir = path.join(work, "frames", name);
  fs.rmSync(framesDir, { recursive: true, force: true });
  const take = new Take({ page, cdp, viewport, output, framesDir });
  let recorded = 0;
  try {
    if (clip.setup) await clip.setup(take);
    await take.start();
    try {
      await clip.run(take);
      await take.until(clip.length + (clip.fade ?? 0) + 60);
    } finally {
      recorded = await take.stop();
    }
  } finally {
    const unknown = await page.evaluate(() => [...window.__clipUnknown]);
    if (errors.length)
      console.log(`  ${name} page errors: ${errors.join(" | ").slice(0, 400)}`);
    if (unknown.length) console.log(`  ${name} unmocked: ${unknown.join(" ")}`);
    await context.close();
  }
  if (recorded < clip.length + (clip.fade ?? 0)) {
    throw new Error(
      `${name}: recorded ${Math.round(recorded)} ms, needs ${clip.length + (clip.fade ?? 0)}`,
    );
  }
  fs.writeFileSync(
    path.join(framesDir, "frames.json"),
    JSON.stringify(take.frames),
    { mode: 0o600 },
  );
  return take.frames;
}

try {
  for (const id of ids) {
    const clip = CLIPS[id];
    for (const theme of themes) {
      const name = `${id}-${theme}`;
      let frames;
      try {
        frames = encodeOnly
          ? JSON.parse(
              fs.readFileSync(
                path.join(work, "frames", name, "frames.json"),
                "utf8",
              ),
            )
          : await record(clip, name, theme);
      } catch (error) {
        failed.push(name);
        console.log(`${name}: FAILED ${String(error.message).split("\n")[0]}`);
        continue;
      }
      const size = encode({ frames, clip, name });
      totals.push(size.webp + size.still);
      console.log(
        `${name}: ${(size.webp / 1024).toFixed(0)} KB + still ${(size.still / 1024).toFixed(0)} KB`,
      );
    }
  }
} finally {
  await browser?.close();
  server.close();
}
const total = totals.reduce((sum, size) => sum + size, 0);
console.log(`${totals.length} clips, ${(total / 1024 / 1024).toFixed(2)} MB`);
if (failed.length) {
  console.log(`Failed: ${failed.join(" ")}`);
  process.exitCode = 1;
}
