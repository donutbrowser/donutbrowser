"use client";

import { motion, useReducedMotion } from "motion/react";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { LuRotateCw, LuX } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import {
  addBite,
  type Bite,
  bakeDonut,
  type Donut,
  type Frame,
  findBiteTarget,
  type Grid,
  isEaten,
  KIND_CRUMB,
  KIND_DOUGH,
  KIND_EMPTY,
  KIND_GLAZE,
  KIND_SPRINKLE,
  layoutGrid,
  type Mat3,
  materialAt,
  remainingShare,
  renderFrame,
  SPRINKLE_COLORS,
  START_ORIENTATION,
  spin,
  turn,
} from "@/lib/donut-lab";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { playUiSound } from "@/lib/ui-sounds";
import { cn } from "@/lib/utils";

/** Radians per pixel of drag, and per arrow key press. */
const DRAG_TURN = 0.011;
const KEY_TURN = 0.26;
/** Radians per second the donut turns on its own axis when left alone. */
const IDLE_SPIN = 0.55;
/** How fast a flick slows down, per second. */
const FRICTION = 2.6;
const MAX_FLICK = 9;
const ASSEMBLY_MS = 700;
const CHOMP_MS = 140;
const GRAVITY = 1100;
const CRUMB_GLYPHS = ".,'`:;*";
const SCRAMBLE = "@%#*+=-:.";
const TARGET_COLS = 64;

type Assembly = {
  start: number;
  /** "burst": out of the logo. "rings": in from rings around the view. */
  mode: "burst" | "rings";
  x: number;
  y: number;
};

interface Crumb {
  x: number;
  y: number;
  vx: number;
  vy: number;
  char: string;
  kind: number;
  age: number;
  life: number;
}

interface Palette {
  foreground: string;
  sprinkles: string[];
  /** The background is light: dense characters are shadow. */
  ink: boolean;
}

function resolvePalette(host: HTMLElement): Palette {
  const probe = document.createElement("span");
  probe.style.display = "none";
  host.append(probe);
  const read = (variable: string) => {
    probe.style.color = `var(${variable})`;
    return getComputedStyle(probe).color;
  };
  const foreground = read("--foreground");
  const sprinkles = Array.from({ length: SPRINKLE_COLORS }, (_, i) =>
    read(`--chart-${i + 1}`),
  );
  const background = read("--background");
  probe.remove();
  let ink = !document.documentElement.classList.contains("dark");
  // Whatever syntax the theme uses, the canvas knows how bright it is.
  const swatch = document.createElement("canvas").getContext("2d", {
    willReadFrequently: true,
  });
  if (swatch) {
    swatch.fillStyle = background;
    swatch.fillRect(0, 0, 1, 1);
    const [r, g, b] = swatch.getImageData(0, 0, 1, 1).data;
    ink = 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
  }
  return { foreground, sprinkles, ink };
}

function easeOut(t: number) {
  return 1 - (1 - t) ** 3;
}

/** A stable pseudo-random 0..1 for a cell, changing every `tick`. */
function flicker(index: number, tick: number) {
  const n = Math.sin(index * 12.9898 + tick * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

const KIND_ALPHA: Record<number, number> = {
  [KIND_DOUGH]: 0.82,
  [KIND_GLAZE]: 1,
  [KIND_CRUMB]: 0.68,
};

interface DonutLabProps {
  /** The logo's center in client pixels: the donut grows out of it. */
  origin: { x: number; y: number } | null;
  onClose: () => void;
}

/**
 * The About easter egg: a donut drawn in text, ray marched live. Drag to
 * turn it, click or press Space to bite it, bake another when it is gone.
 */
export function DonutLab({ origin, onClose }: DonutLabProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion() ?? false;
  const motionAllowed = useMotionAllowed();
  const descriptionId = useId();

  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const donutRef = useRef<Donut | null>(null);
  donutRef.current ??= bakeDonut();
  const orientationRef = useRef<Mat3>(START_ORIENTATION);
  const flickRef = useRef({ x: 0, y: 0 });
  const idleRef = useRef(1);
  const dragRef = useRef<{
    id: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    at: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const crumbsRef = useRef<Crumb[]>([]);
  const chompRef = useRef<{ bite: Bite; start: number } | null>(null);
  const assemblyRef = useRef<Assembly | null>(null);
  const layoutRef = useRef<{
    grid: Grid;
    fontSize: number;
    font: string;
    dpr: number;
  } | null>(null);
  const frameRef = useRef<Frame | null>(null);
  const paletteRef = useRef<Palette | null>(null);
  const rafRef = useRef(0);
  const lastTickRef = useRef(0);
  const motionRef = useRef({ reducedMotion, motionAllowed });
  motionRef.current = { reducedMotion, motionAllowed };

  const [bites, setBites] = useState(0);
  const [left, setLeft] = useState(100);
  const [eaten, setEaten] = useState(false);
  const [dragging, setDragging] = useState(false);

  const draw = useCallback((now: number) => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    const palette = paletteRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !layout || !palette || !context) return;
    const { grid, font, dpr } = layout;
    const donut = donutRef.current;
    if (!donut) return;
    const frame = renderFrame(
      donut,
      orientationRef.current,
      grid,
      palette.ink,
      frameRef.current ?? undefined,
    );
    frameRef.current = frame;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, grid.width, grid.height);
    context.font = font;
    context.textBaseline = "middle";
    context.textAlign = "left";
    const colorOf = (kind: number) =>
      kind >= KIND_SPRINKLE
        ? palette.sprinkles[kind - KIND_SPRINKLE]
        : palette.foreground;
    const alphaOf = (kind: number) => KIND_ALPHA[kind] ?? 1;

    const assembly = assemblyRef.current;
    const progress = assembly
      ? Math.min(1, (now - assembly.start) / ASSEMBLY_MS)
      : 1;
    if (assembly && progress < 1) {
      // Every character flies to its place: out of the logo, or in from
      // rings around the view, still scrambled until it lands.
      const cx = grid.width / 2;
      const cy = grid.height / 2;
      const reach = Math.hypot(cx, cy);
      const tick = Math.floor(now / 45);
      for (
        let kind = KIND_DOUGH;
        kind < KIND_SPRINKLE + SPRINKLE_COLORS;
        kind++
      ) {
        context.fillStyle = colorOf(kind);
        for (let i = 0; i < frame.kinds.length; i++) {
          if (frame.kinds[i] !== kind) continue;
          const col = i % grid.cols;
          const row = (i - col) / grid.cols;
          const fx = grid.offsetX + (col + 0.5) * grid.cellWidth;
          const fy = grid.offsetY + (row + 0.5) * grid.cellHeight;
          const distance = Math.hypot(fx - cx, fy - cy) / reach;
          const delay =
            (assembly.mode === "burst" ? distance : 1 - distance) * 0.35;
          const local = easeOut(
            Math.min(1, Math.max(0, (progress - delay) / 0.65)),
          );
          let x: number;
          let y: number;
          if (assembly.mode === "burst") {
            const sx = assembly.x + (fx - assembly.x) * 0.15;
            const sy = assembly.y + (fy - assembly.y) * 0.15;
            x = sx + (fx - sx) * local;
            y = sy + (fy - sy) * local;
          } else {
            const angle = Math.atan2(fy - cy, fx - cx) + 0.9 * (1 - local);
            const radius =
              Math.hypot(fx - cx, fy - cy) + reach * 0.6 * (1 - local);
            x = cx + Math.cos(angle) * radius;
            y = cy + Math.sin(angle) * radius;
          }
          const char =
            local < 0.75
              ? SCRAMBLE[Math.floor(flicker(i, tick) * SCRAMBLE.length)]
              : frame.chars[i];
          context.globalAlpha = alphaOf(kind) * (0.55 + 0.45 * local);
          context.fillText(char, x - grid.cellWidth / 2, y);
        }
      }
    } else {
      if (assembly) assemblyRef.current = null;
      // One string per row and color: spaces keep the columns.
      const rowChars = Array.from(
        { length: KIND_SPRINKLE + SPRINKLE_COLORS },
        () => new Array<string>(grid.cols),
      );
      const used = new Array<boolean>(KIND_SPRINKLE + SPRINKLE_COLORS);
      for (let row = 0; row < grid.rows; row++) {
        used.fill(false);
        for (const chars of rowChars) chars.fill(" ");
        for (let col = 0; col < grid.cols; col++) {
          const i = row * grid.cols + col;
          const kind = frame.kinds[i];
          if (kind === KIND_EMPTY) continue;
          rowChars[kind][col] = frame.chars[i];
          used[kind] = true;
        }
        const y = grid.offsetY + (row + 0.5) * grid.cellHeight;
        for (let kind = KIND_DOUGH; kind < rowChars.length; kind++) {
          if (!used[kind]) continue;
          context.fillStyle = colorOf(kind);
          context.globalAlpha = alphaOf(kind);
          context.fillText(rowChars[kind].join(""), grid.offsetX, y);
        }
      }
    }

    for (const crumb of crumbsRef.current) {
      context.fillStyle = colorOf(crumb.kind);
      context.globalAlpha =
        alphaOf(crumb.kind) * Math.min(1, (crumb.life - crumb.age) / 0.4);
      context.fillText(crumb.char, crumb.x, crumb.y);
    }
    context.globalAlpha = 1;
  }, []);

  const needsFrames = useCallback(() => {
    const flick = flickRef.current;
    return (
      !motionRef.current.reducedMotion ||
      Math.abs(flick.x) + Math.abs(flick.y) > 0.01 ||
      crumbsRef.current.length > 0 ||
      chompRef.current !== null ||
      assemblyRef.current !== null
    );
  }, []);

  const tick = useCallback(
    (now: number) => {
      rafRef.current = 0;
      const dt = Math.min(
        0.05,
        Math.max(0, (now - lastTickRef.current) / 1000),
      );
      lastTickRef.current = now;
      const { reducedMotion: reduced } = motionRef.current;

      if (!dragRef.current?.moved) {
        const flick = flickRef.current;
        let m = orientationRef.current;
        if (Math.abs(flick.x) + Math.abs(flick.y) > 0.01) {
          m = turn(m, flick.x * dt, flick.y * dt);
          const decay = Math.exp(-FRICTION * dt);
          flick.x *= decay;
          flick.y *= decay;
        } else {
          flick.x = 0;
          flick.y = 0;
        }
        if (!reduced) {
          idleRef.current = Math.min(1, idleRef.current + dt * 0.8);
          m = spin(m, IDLE_SPIN * idleRef.current * dt);
        }
        orientationRef.current = m;
      }

      const chomp = chompRef.current;
      if (chomp) {
        const p = Math.min(1, (now - chomp.start) / CHOMP_MS);
        chomp.bite.grow = 0.35 + 0.65 * easeOut(p);
        if (p >= 1) chompRef.current = null;
      }

      const layout = layoutRef.current;
      if (layout && crumbsRef.current.length > 0) {
        const floor = layout.grid.height - layout.grid.cellHeight * 0.6;
        crumbsRef.current = crumbsRef.current.filter((crumb) => {
          crumb.age += dt;
          crumb.vy += GRAVITY * dt;
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

      draw(now);
      if (document.visibilityState === "visible" && needsFrames()) {
        rafRef.current = requestAnimationFrame(tick);
      }
    },
    [draw, needsFrames],
  );

  /** Draws now, and keeps drawing while something moves. */
  const wake = useCallback(() => {
    const now = performance.now();
    draw(now);
    if (
      !rafRef.current &&
      document.visibilityState === "visible" &&
      needsFrames()
    ) {
      lastTickRef.current = now;
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [draw, needsFrames, tick]);

  // Size the canvas to its box and lay the character grid over it.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    paletteRef.current = resolvePalette(host);
    const family = getComputedStyle(canvas).fontFamily || "monospace";
    const measure = canvas.getContext("2d");
    if (measure) measure.font = `100px ${family}`;
    let advance = (measure?.measureText("M").width ?? 60) / 100;
    const resize = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const { grid, fontSize } = layoutGrid(
        width,
        height,
        advance,
        TARGET_COLS,
      );
      layoutRef.current = {
        grid,
        fontSize,
        font: `${fontSize}px ${family}`,
        dpr,
      };
      frameRef.current = null;
      wake();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    // Measure again once the mono font is in, if it was not yet.
    let alive = true;
    void document.fonts?.load(`16px ${family}`).then(() => {
      if (!alive || !measure) return;
      measure.font = `100px ${family}`;
      advance = measure.measureText("M").width / 100 || advance;
      resize();
    });
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [wake]);

  // The donut takes the keys, and grows out of the logo the first time.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    canvas?.focus({ preventScroll: true });
    if (!canvas || !origin || !motionRef.current.motionAllowed) return;
    const rect = canvas.getBoundingClientRect();
    assemblyRef.current = {
      start: performance.now(),
      mode: "burst",
      x: origin.x - rect.left,
      y: origin.y - rect.top,
    };
    wake();
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") wake();
      else if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [wake]);

  // Reduced motion stops the idle spin; a change of setting restarts frames.
  useEffect(() => {
    if (reducedMotion) {
      flickRef.current = { x: 0, y: 0 };
      crumbsRef.current = [];
    }
    wake();
  }, [reducedMotion, wake]);

  const takeBite = useCallback(
    (x: number, y: number, reach: number) => {
      const layout = layoutRef.current;
      const donut = donutRef.current;
      if (!layout || !donut || isEaten(donut)) return;
      const target = findBiteTarget(
        donut,
        orientationRef.current,
        layout.grid,
        x,
        y,
        reach,
      );
      if (!target) return;
      const { material, sprinkle } = materialAt(donut, target.point);
      const animate = !motionRef.current.reducedMotion;
      const bite = addBite(
        donut,
        target.point,
        target.normal,
        animate ? 0.35 : 1,
      );
      playUiSound("crunch");
      if (animate) {
        chompRef.current = { bite, start: performance.now() };
        const kind =
          material === "glaze"
            ? KIND_GLAZE
            : material === "crumb"
              ? KIND_CRUMB
              : KIND_DOUGH;
        const count = 7 + Math.floor(Math.random() * 5);
        for (let i = 0; i < count; i++) {
          const fromSprinkle = material === "sprinkle" && i < 2;
          crumbsRef.current.push({
            x: target.x + (Math.random() - 0.5) * layout.grid.cellWidth * 2,
            y: target.y,
            vx: (Math.random() - 0.5) * 220,
            vy: -80 - Math.random() * 220,
            char: fromSprinkle
              ? "-"
              : CRUMB_GLYPHS[Math.floor(Math.random() * CRUMB_GLYPHS.length)],
            kind: fromSprinkle
              ? KIND_SPRINKLE + donut.sprinkles[sprinkle].color
              : kind,
            age: 0,
            life: 1.1 + Math.random() * 0.8,
          });
        }
        // The donut rocks a little under the bite.
        flickRef.current.x += (Math.random() - 0.5) * 1.2;
        flickRef.current.y += (Math.random() - 0.5) * 1.2;
      }
      const share = remainingShare(donut);
      setBites(donut.bites.length);
      setLeft(Math.round(share * 100));
      setEaten(isEaten(donut, share));
      wake();
    },
    [wake],
  );

  const biteNearCenter = useCallback(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    const { width, height } = layout.grid;
    takeBite(width / 2, height / 2, Math.max(width, height));
  }, [takeBite]);

  const bakeAnother = useCallback(() => {
    donutRef.current = bakeDonut();
    chompRef.current = null;
    setBites(0);
    setLeft(100);
    setEaten(false);
    const layout = layoutRef.current;
    if (layout && motionRef.current.motionAllowed) {
      assemblyRef.current = {
        start: performance.now(),
        mode: "rings",
        x: layout.grid.width / 2,
        y: layout.grid.height / 2,
      };
    }
    canvasRef.current?.focus();
    wake();
  }, [wake]);

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer cannot be captured; the drag still works inside.
    }
    dragRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      at: event.timeStamp,
      moved: false,
    };
    suppressClickRef.current = false;
    flickRef.current = { x: 0, y: 0 };
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    if (
      !drag.moved &&
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4
    ) {
      return;
    }
    if (!drag.moved) {
      drag.moved = true;
      setDragging(true);
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const dt = Math.max(0.008, (event.timeStamp - drag.at) / 1000);
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.at = event.timeStamp;
    orientationRef.current = turn(
      orientationRef.current,
      dy * DRAG_TURN,
      dx * DRAG_TURN,
    );
    // The flick is the drag's recent speed, smoothed.
    const flick = flickRef.current;
    flick.x = flick.x * 0.6 + ((dy * DRAG_TURN) / dt) * 0.4;
    flick.y = flick.y * 0.6 + ((dx * DRAG_TURN) / dt) * 0.4;
    wake();
  };

  const endDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null;
    if (!drag.moved) return;
    suppressClickRef.current = true;
    setDragging(false);
    idleRef.current = 0;
    const flick = flickRef.current;
    // A drag that stopped before release does not fling.
    const still = event.timeStamp - drag.at > 80;
    if (motionRef.current.reducedMotion || still) {
      flick.x = 0;
      flick.y = 0;
    } else {
      flick.x = Math.max(-MAX_FLICK, Math.min(MAX_FLICK, flick.x));
      flick.y = Math.max(-MAX_FLICK, Math.min(MAX_FLICK, flick.y));
    }
    wake();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const turns: Record<string, [number, number]> = {
      ArrowUp: [-KEY_TURN, 0],
      ArrowDown: [KEY_TURN, 0],
      ArrowLeft: [0, -KEY_TURN],
      ArrowRight: [0, KEY_TURN],
    };
    const step = turns[event.key];
    if (step) {
      event.preventDefault();
      flickRef.current = { x: 0, y: 0 };
      idleRef.current = 0;
      orientationRef.current = turn(orientationRef.current, ...step);
      wake();
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) biteNearCenter();
    }
  };

  const status =
    bites === 0
      ? t("about.lab.hint")
      : t("about.lab.status", { count: bites, left });

  return (
    <motion.div
      ref={hostRef}
      data-slot="donut-lab"
      data-bites={bites}
      data-state={eaten ? "eaten" : "whole"}
      // Readable from the first frame: the entry only settles its scale.
      initial={motionAllowed ? { scale: 0.985 } : false}
      animate={{ scale: 1 }}
      transition={{ duration: MOTION_DURATION.base, ease: MOTION_EASE_OUT }}
      className="absolute inset-0 z-20 overflow-hidden rounded-[inherit] bg-background/95 bg-[radial-gradient(circle_at_50%_48%,color-mix(in_oklab,var(--foreground)_7%,transparent),transparent_62%)]"
    >
      <canvas
        ref={canvasRef}
        role="img"
        tabIndex={0}
        aria-label={t("about.lab.label", { left })}
        aria-describedby={descriptionId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          const layout = layoutRef.current;
          // A click with no pointer behind it came from a key or a script.
          if (event.detail === 0 || !layout) {
            biteNearCenter();
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          takeBite(
            event.clientX - rect.left,
            event.clientY - rect.top,
            Math.min(layout.grid.width, layout.grid.height) * 0.22,
          );
        }}
        onKeyDown={onKeyDown}
        className={cn(
          "absolute inset-0 size-full touch-none font-mono outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
      />
      <p id={descriptionId} className="sr-only">
        {t("about.lab.description")}
      </p>
      <p className="sr-only" aria-live="polite">
        {bites > 0 && (eaten ? t("about.lab.eaten") : status)}
      </p>
      <Button
        type="button"
        variant="subtle"
        size="icon"
        className="absolute top-3 right-3 size-8"
        aria-label={t("about.lab.close")}
        onClick={onClose}
      >
        <LuX aria-hidden="true" />
      </Button>
      <div className="pointer-events-none absolute inset-x-4 bottom-3 flex min-h-8 items-center justify-between gap-3">
        <p
          aria-hidden="true"
          className="truncate font-mono text-[11px] text-muted-foreground tabular-nums"
        >
          {eaten ? t("about.lab.eaten") : status}
        </p>
        {eaten && (
          <Button
            type="button"
            variant="soft"
            size="sm"
            className="pointer-events-auto"
            onClick={bakeAnother}
          >
            <LuRotateCw aria-hidden="true" />
            {t("about.lab.bakeAnother")}
          </Button>
        )}
      </div>
    </motion.div>
  );
}
