// One recorded take: drives the app in slow motion and captures frames, each
// cropped to the camera and with the cursor drawn in.
import fs from "node:fs";
import path from "node:path";

/** How much slower than real time a take runs, so capture keeps up. */
const SLOWDOWN = 4;
/** The cursor's height in output pixels, the same in every clip. */
const CURSOR_PX = 40;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A value that eases between keyframes, sampled at any time. */
class Track {
  constructor(initial) {
    this.segments = [{ t0: 0, t1: 0, from: initial, to: initial }];
  }
  at(t) {
    let active = this.segments[0];
    for (const segment of this.segments) if (segment.t0 <= t) active = segment;
    if (t >= active.t1) return active.to;
    const k = easeInOut((t - active.t0) / (active.t1 - active.t0));
    return active.mix(active.from, active.to, k);
  }
  go(t0, dur, to, mix) {
    const from = this.at(t0);
    this.segments.push({ t0, t1: t0 + dur, from, to, mix });
  }
}

const mixRect = (a, b, k) => ({
  x: lerp(a.x, b.x, k),
  y: lerp(a.y, b.y, k),
  w: lerp(a.w, b.w, k),
});
const mixPoint = (a, b, k) => {
  // A slight arc, as a hand moves, instead of a ruler line.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const bow = Math.sin(Math.PI * k) * 0.08;
  return {
    x: lerp(a.x, b.x, k) - dy * bow,
    y: lerp(a.y, b.y, k) + dx * bow,
    visible: b.visible,
  };
};

export class Take {
  constructor({ page, cdp, viewport, output, framesDir }) {
    this.page = page;
    this.cdp = cdp;
    this.viewport = viewport;
    this.output = output;
    this.framesDir = framesDir;
    this.aspect = output.width / output.height;
    this.frames = [];
    this.clicks = [];
    this.huds = [];
    /** Whatever a clip's setup measures for its run. */
    this.state = {};
    this.recording = false;
    const full = this.fit({
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
    });
    this.cam = new Track(full);
    this.cursor = new Track({
      x: viewport.width * 0.62,
      y: viewport.height * 0.7,
      visible: true,
    });
  }

  /** Virtual milliseconds since the take started. */
  now() {
    if (!this.recording) return 0;
    return (performance.now() - this.realStart) / SLOWDOWN;
  }

  async until(t) {
    if (!this.recording) return;
    const realTarget = this.realStart + t * SLOWDOWN;
    const left = realTarget - performance.now();
    if (left > 0) await sleep(left);
  }

  wait(ms) {
    return this.until(this.now() + ms);
  }

  async setRate(rate) {
    await this.page.evaluate((r) => window.__clipSetRate(r), rate);
    await this.cdp.send("Animation.setPlaybackRate", { playbackRate: rate });
  }

  /** The bounding box of a locator, a selector or a rect, in CSS pixels. */
  async box(target) {
    if (target && typeof target.width === "number") return target;
    const locator =
      typeof target === "string" ? this.page.locator(target).first() : target;
    const box = await locator.boundingBox();
    if (!box) throw new Error(`No box for ${target}`);
    return box;
  }

  /** A camera rect at the output aspect that holds `rect` with padding. */
  fit(rect, { pad = 20, width } = {}) {
    const vw = this.viewport.width;
    const vh = this.viewport.height;
    let w = Math.max(
      rect.width + pad * 2,
      (rect.height + pad * 2) * this.aspect,
    );
    if (width) w = Math.max(width, w);
    w = Math.min(w, vw, vh * this.aspect);
    const h = w / this.aspect;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    return {
      x: Math.min(Math.max(cx - w / 2, 0), vw - w),
      y: Math.min(Math.max(cy - h / 2, 0), vh - h),
      w,
    };
  }

  /** Moves the camera onto a target; `dur` 0 cuts. */
  async camera(target, { dur = 700, pad, width, union } = {}) {
    let rect = await this.box(target);
    for (const extra of union || []) {
      const other = await this.box(extra);
      const x = Math.min(rect.x, other.x);
      const y = Math.min(rect.y, other.y);
      rect = {
        x,
        y,
        width: Math.max(rect.x + rect.width, other.x + other.width) - x,
        height: Math.max(rect.y + rect.height, other.y + other.height) - y,
      };
    }
    this.cam.go(this.now(), dur, this.fit(rect, { pad, width }), mixRect);
  }

  async point(target, { at = [0.5, 0.5] } = {}) {
    if (target && typeof target.x === "number" && target.width === undefined) {
      return target;
    }
    const box = await this.box(target);
    return { x: box.x + box.width * at[0], y: box.y + box.height * at[1] };
  }

  /**
   * Parks the real mouse where it hovers nothing in frame. The drawn cursor
   * can rest elsewhere: a resting cursor then shows no hover state, so the
   * first and last frames of a loop match.
   */
  async park() {
    await this.page.mouse.move(
      this.viewport.width - 2,
      this.viewport.height - 2,
    );
  }

  /** Puts the cursor somewhere without a move; the real mouse stays parked. */
  async place(target, { at, hover = false } = {}) {
    const p = await this.point(target, { at });
    this.cursor.go(this.now(), 0, { ...p, visible: true }, mixPoint);
    if (hover) await this.page.mouse.move(p.x, p.y);
    else await this.park();
  }

  /** Moves the cursor; with `hover` false the real mouse stays parked. */
  async move(target, { dur = 650, at, hover = true } = {}) {
    const to = { ...(await this.point(target, { at })), visible: true };
    const t0 = this.now();
    this.cursor.go(t0, dur, to, mixPoint);
    if (!hover) {
      await this.park();
      await this.until(t0 + dur);
      return;
    }
    const steps = Math.max(2, Math.round(dur / 45));
    for (let i = 1; i <= steps; i += 1) {
      await this.until(t0 + (dur * i) / steps);
      const p = this.cursor.at(t0 + (dur * i) / steps);
      await this.page.mouse.move(p.x, p.y);
    }
  }

  async click(target, { dur, at, hold = 90 } = {}) {
    if (target) await this.move(target, { dur, at });
    const p = this.cursor.at(this.now());
    this.clicks.push({ t: this.now(), x: p.x, y: p.y });
    await this.page.mouse.down();
    await this.wait(hold);
    await this.page.mouse.up();
  }

  async type(text, { cps = 16 } = {}) {
    for (const char of text) {
      await this.page.keyboard.type(char);
      await this.wait(1000 / cps);
    }
  }

  async press(key, { after = 120 } = {}) {
    await this.page.keyboard.press(key);
    await this.wait(after);
  }

  /** Presses a chord and shows its keys at the bottom of the frame. */
  async keys(chord, labels, { show = 900, after = 150 } = {}) {
    this.huds.push({ t: this.now(), labels, dur: show });
    await this.wait(120);
    await this.page.keyboard.press(chord);
    await this.wait(after);
  }

  hideCursor({ dur = 200 } = {}) {
    const p = this.cursor.at(this.now());
    this.cursor.go(this.now(), dur, { ...p, visible: false }, mixPoint);
  }

  async start() {
    await this.page.evaluate(() => {
      const cursor = document.createElement("div");
      cursor.id = "__clip_cursor";
      cursor.innerHTML =
        '<svg width="20" height="28" viewBox="0 0 20 28"><path d="M2 2 L2 22 L7 17.5 L10.5 25.5 L14 24 L10.6 16.2 L17 16.2 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      const ring = document.createElement("div");
      ring.id = "__clip_ring";
      for (const el of [cursor, ring]) {
        Object.assign(el.style, {
          position: "fixed",
          left: "0",
          top: "0",
          pointerEvents: "none",
          zIndex: "2147483647",
          transformOrigin: "0 0",
        });
      }
      Object.assign(ring.style, {
        width: "40px",
        height: "40px",
        borderRadius: "50%",
        background: "rgba(127,127,127,0.35)",
        opacity: "0",
      });
      cursor.style.filter = "drop-shadow(0 1px 1.5px rgba(0,0,0,0.35))";
      const keys = document.createElement("div");
      keys.id = "__clip_keys";
      Object.assign(keys.style, {
        position: "fixed",
        left: "0",
        top: "0",
        pointerEvents: "none",
        zIndex: "2147483647",
        transformOrigin: "0 0",
        display: "flex",
        gap: "8px",
        padding: "10px",
        borderRadius: "18px",
        background: "rgba(20,20,22,0.82)",
        boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
        opacity: "0",
      });
      document.body.append(ring, keys, cursor);
    });
    fs.mkdirSync(this.framesDir, { recursive: true });
    await this.setRate(1 / SLOWDOWN);
    this.realStart = performance.now();
    this.recording = true;
    this.loop = this.captureLoop();
  }

  async captureLoop() {
    while (this.recording) {
      const t = this.now();
      const cam = this.cam.at(t);
      const scale = this.output.width / cam.w;
      const cursor = this.cursor.at(t);
      const click = this.clicks.findLast((c) => t >= c.t && t - c.t < 420);
      const pressed = this.clicks.some((c) => t >= c.t && t - c.t < 140);
      const hud = this.huds.findLast((h) => t >= h.t && t < h.t + h.dur);
      const keys = hud && {
        labels: hud.labels,
        opacity: Math.min(1, (t - hud.t) / 120, (hud.t + hud.dur - t) / 200),
        x: cam.x + cam.w / 2,
        y: cam.y + cam.w / this.aspect - 22 / scale,
      };
      await this.page.evaluate(
        ({ cursor, scale, size, click, pressed, t, keys }) => {
          const hud = document.getElementById("__clip_keys");
          if (keys) {
            const text = keys.labels.join("\u0000");
            if (hud.dataset.text !== text) {
              hud.dataset.text = text;
              hud.replaceChildren(
                ...keys.labels.map((label) => {
                  const cap = document.createElement("kbd");
                  cap.textContent = label;
                  Object.assign(cap.style, {
                    minWidth: "46px",
                    height: "46px",
                    padding: "0 12px",
                    display: "inline-grid",
                    placeItems: "center",
                    borderRadius: "10px",
                    background: "rgba(255,255,255,0.14)",
                    font: "600 24px/1 ui-sans-serif, system-ui, sans-serif",
                    color: "#fff",
                  });
                  return cap;
                }),
              );
            }
            hud.style.opacity = String(keys.opacity);
            hud.style.transform = `translate(${keys.x}px, ${keys.y}px) scale(${1 / scale}) translate(-50%, -100%)`;
          } else {
            hud.style.opacity = "0";
          }
          const el = document.getElementById("__clip_cursor");
          const s = size / 28 / scale;
          el.style.opacity = cursor.visible === false ? "0" : "1";
          el.style.transform = `translate(${cursor.x - 2 * s}px, ${cursor.y - 2 * s}px) scale(${s * (pressed ? 0.88 : 1)})`;
          const ring = document.getElementById("__clip_ring");
          if (click) {
            const k = (t - click.t) / 420;
            const r = (8 + 26 * k) / scale;
            ring.style.opacity = String(0.9 * (1 - k));
            ring.style.transform = `translate(${click.x - r}px, ${click.y - r}px) scale(${(r * 2) / 40})`;
          } else {
            ring.style.opacity = "0";
          }
        },
        { cursor, scale, size: CURSOR_PX, click, pressed, t, keys },
      );
      const { data } = await this.cdp.send("Page.captureScreenshot", {
        format: "png",
        optimizeForSpeed: true,
        clip: {
          x: cam.x,
          y: cam.y,
          width: cam.w,
          height: cam.w / this.aspect,
          scale,
        },
      });
      const file = path.join(
        this.framesDir,
        `${String(this.frames.length).padStart(5, "0")}.png`,
      );
      fs.writeFileSync(file, Buffer.from(data, "base64"), { mode: 0o600 });
      this.frames.push({ t, file });
    }
  }

  async stop() {
    const duration = this.now();
    this.recording = false;
    await this.loop;
    await this.setRate(1);
    return duration;
  }
}
