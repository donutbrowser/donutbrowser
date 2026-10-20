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
  type CellMetrics,
  CRUMB_GLYPHS,
  type Crumb,
  centerLens,
  crumbAlpha,
  DEFAULT_CELL,
  type Donut,
  type Frame,
  findBiteTarget,
  forEachGlyph,
  forEachRun,
  GLYPHS,
  type Grid,
  isEaten,
  KIND_CRUMB,
  KIND_DOUGH,
  KIND_GLAZE,
  KIND_SPRINKLE,
  layoutGrid,
  MAX_FLICK,
  type Mat3,
  type Momentum,
  materialAt,
  type Pose,
  REVEAL_MS,
  type RevealOrigin,
  remainingShare,
  renderFrame,
  revealPose,
  SPRINKLE_COLORS,
  START_ORIENTATION,
  spinStep,
  stepCrumbs,
  turn,
} from "@/lib/donut-lab";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { playUiSound } from "@/lib/ui-sounds";
import { cn } from "@/lib/utils";

/** Radians per pixel of drag, and per arrow key press. */
const DRAG_TURN = 0.011;
const KEY_TURN = 0.26;
const CHOMP_MS = 140;
/** The longest step the clock takes between two frames, in seconds. */
const MAX_STEP = 0.1;
/** Ends the reveal when frames stop coming (a paused webview). */
const REVEAL_FALLBACK_MS = REVEAL_MS + 400;
/** The logo's size, when the opener does not give it. */
const LOGO_SIZE = 56;
const MONO_FALLBACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace';

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

/**
 * The mono font stack. The `font-mono` class does not reach it: the theme
 * reads --font-geist-mono at :root, and next/font sets it on body.
 */
function monoFamily(host: HTMLElement) {
  return (
    getComputedStyle(host).getPropertyValue("--font-geist-mono").trim() ||
    MONO_FALLBACK
  );
}

/**
 * The cell of the font the canvas draws with: its widest glyph, its line, and
 * whether every glyph has the same advance.
 */
function measureCell(
  context: CanvasRenderingContext2D,
  family: string,
): CellMetrics {
  context.font = `100px ${family}`;
  let widest = 0;
  let narrowest = Number.POSITIVE_INFINITY;
  for (const char of GLYPHS) {
    const width = context.measureText(char).width;
    widest = Math.max(widest, width);
    narrowest = Math.min(narrowest, width);
  }
  const metrics = context.measureText("M");
  const line =
    (metrics.fontBoundingBoxAscent ?? 0) +
    (metrics.fontBoundingBoxDescent ?? 0);
  return {
    advance: widest / 100 || DEFAULT_CELL.advance,
    lineHeight: line > 0 ? line / 100 : DEFAULT_CELL.lineHeight,
    mono: widest > 0 && widest - narrowest < 0.2,
  };
}

function easeOut(t: number) {
  return 1 - (1 - t) ** 3;
}

const KIND_ALPHA: Record<number, number> = {
  [KIND_DOUGH]: 0.82,
  [KIND_GLAZE]: 1,
  [KIND_CRUMB]: 0.68,
};

interface DonutLabProps {
  /** The logo's center (and width) in client pixels: the donut comes out of it. */
  origin: { x: number; y: number; size?: number } | null;
  onClose: () => void;
}

/**
 * The About easter egg: a donut drawn in text, ray marched live. Drag to
 * turn it, click or press Space to bite it, bake another when it is gone.
 * Every motion runs on one clock that advances with frame time.
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
  const momentumRef = useRef<Momentum>({ x: 0, y: 0, idle: 1 });
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
  /** Milliseconds of animation so far: frame time, each step clamped. */
  const clockRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);
  const revealRef = useRef<{ start: number; origin: RevealOrigin } | null>(
    null,
  );
  const revealTimerRef = useRef(0);
  const poseRef = useRef<Pose | null>(null);
  const layoutRef = useRef<{
    grid: Grid;
    font: string;
    mono: boolean;
  } | null>(null);
  const frameRef = useRef<Frame | null>(null);
  const paletteRef = useRef<Palette | null>(null);
  const rafRef = useRef(0);
  const motionRef = useRef({ reducedMotion, motionAllowed });
  motionRef.current = { reducedMotion, motionAllowed };

  const [bites, setBites] = useState(0);
  const [left, setLeft] = useState(100);
  const [eaten, setEaten] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<"reveal" | "ready">(() =>
    origin && motionAllowed ? "reveal" : "ready",
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    const palette = paletteRef.current;
    const donut = donutRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !layout || !palette || !donut || !context) return;
    const { grid, font, mono } = layout;
    const reveal = revealRef.current;
    const pose = revealPose(
      orientationRef.current,
      grid,
      reveal?.origin ?? null,
      reveal ? clockRef.current - reveal.start : Number.POSITIVE_INFINITY,
    );
    poseRef.current = pose;
    const frame = renderFrame(
      donut,
      pose.orientation,
      grid,
      palette.ink,
      frameRef.current ?? undefined,
      pose.lens,
    );
    frameRef.current = frame;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(
      canvas.width / grid.width,
      0,
      0,
      canvas.height / grid.height,
      0,
      0,
    );
    context.font = font;
    context.fontKerning = "none";
    context.textBaseline = "middle";
    const colorOf = (kind: number) =>
      kind >= KIND_SPRINKLE
        ? palette.sprinkles[kind - KIND_SPRINKLE]
        : palette.foreground;
    // Glyphs stay in their cells: a monospace font draws runs of cells from
    // their left edge, any other font draws each glyph at its cell's center.
    context.textAlign = mono ? "left" : "center";
    const fill = (text: string, x: number, y: number) => {
      context.fillText(text, x, y);
    };
    for (
      let kind = KIND_DOUGH;
      kind < KIND_SPRINKLE + SPRINKLE_COLORS;
      kind++
    ) {
      context.fillStyle = colorOf(kind);
      context.globalAlpha = KIND_ALPHA[kind] ?? 1;
      if (mono) forEachRun(frame, grid, fill, kind);
      else forEachGlyph(frame, grid, fill, kind);
    }
    context.textAlign = "center";
    for (const crumb of crumbsRef.current) {
      context.fillStyle = colorOf(crumb.kind);
      context.globalAlpha = (KIND_ALPHA[crumb.kind] ?? 1) * crumbAlpha(crumb);
      context.fillText(crumb.char, crumb.x, crumb.y);
    }
    context.globalAlpha = 1;
  }, []);

  const finishReveal = useCallback(() => {
    window.clearTimeout(revealTimerRef.current);
    if (!revealRef.current) return;
    revealRef.current = null;
    setPhase("ready");
  }, []);

  const needsFrames = useCallback(() => {
    const momentum = momentumRef.current;
    return (
      !motionRef.current.reducedMotion ||
      momentum.x !== 0 ||
      momentum.y !== 0 ||
      crumbsRef.current.length > 0 ||
      chompRef.current !== null ||
      revealRef.current !== null
    );
  }, []);

  const tick = useCallback(
    (now: number) => {
      rafRef.current = 0;
      const last = lastFrameRef.current;
      lastFrameRef.current = now;
      const dt =
        last === null
          ? 0
          : Math.min(MAX_STEP, Math.max(0, (now - last) / 1000));
      clockRef.current += dt * 1000;
      const clock = clockRef.current;

      if (!dragRef.current?.moved) {
        orientationRef.current = spinStep(
          orientationRef.current,
          momentumRef.current,
          dt,
          !motionRef.current.reducedMotion,
        );
      }

      const reveal = revealRef.current;
      if (reveal && clock - reveal.start >= REVEAL_MS) finishReveal();

      const chomp = chompRef.current;
      if (chomp) {
        const p = Math.min(1, (clock - chomp.start) / CHOMP_MS);
        chomp.bite.grow = 0.35 + 0.65 * easeOut(p);
        if (p >= 1) chompRef.current = null;
      }

      const layout = layoutRef.current;
      if (layout && crumbsRef.current.length > 0) {
        crumbsRef.current = stepCrumbs(
          crumbsRef.current,
          dt,
          layout.grid.height - layout.grid.cellHeight * 0.6,
        );
      }

      draw();
      if (document.visibilityState === "visible" && needsFrames()) {
        rafRef.current = requestAnimationFrame(tick);
      }
    },
    [draw, finishReveal, needsFrames],
  );

  /** Draws now, and keeps drawing while something moves. */
  const wake = useCallback(() => {
    draw();
    if (
      !rafRef.current &&
      document.visibilityState === "visible" &&
      needsFrames()
    ) {
      lastFrameRef.current = null;
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [draw, needsFrames, tick]);

  /** Starts the donut at `start` (canvas pixels), or at rest when motion is off. */
  const startReveal = useCallback(
    (start: RevealOrigin | null) => {
      window.clearTimeout(revealTimerRef.current);
      if (!start || !motionRef.current.motionAllowed) {
        revealRef.current = null;
        setPhase("ready");
        return;
      }
      revealRef.current = { start: clockRef.current, origin: start };
      setPhase("reveal");
      revealTimerRef.current = window.setTimeout(() => {
        finishReveal();
        draw();
      }, REVEAL_FALLBACK_MS);
    },
    [draw, finishReveal],
  );

  // Size the canvas to its box, in device pixels, and lay the grid over it
  // again whenever the box, the pixel ratio or the font changes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !host || !context) return;
    paletteRef.current = resolvePalette(host);
    const family = monoFamily(host);
    let cell = measureCell(context, family);
    const resize = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const backingWidth = Math.max(1, Math.round(width * dpr));
      const backingHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== backingWidth) canvas.width = backingWidth;
      if (canvas.height !== backingHeight) canvas.height = backingHeight;
      const { grid, fontSize } = layoutGrid(width, height, cell);
      layoutRef.current = {
        grid,
        font: `${fontSize}px ${family}`,
        mono: cell.mono === true,
      };
      frameRef.current = null;
      wake();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    let media: MediaQueryList | null = null;
    const onPixelRatio = () => {
      watchPixelRatio();
      resize();
    };
    const watchPixelRatio = () => {
      media?.removeEventListener("change", onPixelRatio);
      media =
        window.matchMedia?.(
          `(resolution: ${window.devicePixelRatio || 1}dppx)`,
        ) ?? null;
      media?.addEventListener("change", onPixelRatio);
    };
    watchPixelRatio();

    // The mono font may load after the first frame: measure it again then.
    let alive = true;
    const remeasure = () => {
      if (!alive) return;
      cell = measureCell(context, family);
      resize();
    };
    void document.fonts?.load(`16px ${family}`, GLYPHS).then(remeasure);
    document.fonts?.addEventListener("loadingdone", remeasure);
    return () => {
      alive = false;
      observer.disconnect();
      media?.removeEventListener("change", onPixelRatio);
      document.fonts?.removeEventListener("loadingdone", remeasure);
    };
  }, [wake]);

  // The donut takes the keys, and comes out of the logo the first time.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    canvas?.focus({ preventScroll: true });
    if (!canvas || !origin) {
      startReveal(null);
      wake();
      return;
    }
    // The box may be scaled by an entry animation: map client pixels to its own.
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width > 0 ? canvas.clientWidth / rect.width : 1;
    const clamp = (value: number, max: number) =>
      Math.min(max, Math.max(0, value));
    startReveal({
      x: clamp((origin.x - rect.left) * scale, canvas.clientWidth),
      y: clamp((origin.y - rect.top) * scale, canvas.clientHeight),
      size: (origin.size ?? LOGO_SIZE) * scale,
    });
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
      window.clearTimeout(revealTimerRef.current);
    };
  }, [wake]);

  // Reduced motion stops the idle spin; a change of setting restarts frames.
  useEffect(() => {
    if (reducedMotion) {
      momentumRef.current = { x: 0, y: 0, idle: 0 };
      crumbsRef.current = [];
    }
    wake();
  }, [reducedMotion, wake]);

  /** Where the donut is drawn now, so a press bites what it is on. */
  const currentPose = useCallback((grid: Grid): Pose => {
    return (
      poseRef.current ?? {
        orientation: orientationRef.current,
        lens: centerLens(grid),
      }
    );
  }, []);

  const takeBite = useCallback(
    (x: number, y: number, reach: number) => {
      const layout = layoutRef.current;
      const donut = donutRef.current;
      if (!layout || !donut || isEaten(donut)) return;
      const pose = currentPose(layout.grid);
      const target = findBiteTarget(
        donut,
        pose.orientation,
        layout.grid,
        x,
        y,
        reach,
        pose.lens,
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
        chompRef.current = { bite, start: clockRef.current };
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
        momentumRef.current.x += (Math.random() - 0.5) * 1.2;
        momentumRef.current.y += (Math.random() - 0.5) * 1.2;
      }
      const share = remainingShare(donut);
      setBites(donut.bites.length);
      setLeft(Math.round(share * 100));
      setEaten(isEaten(donut, share));
      wake();
    },
    [currentPose, wake],
  );

  const biteNearCenter = useCallback(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    const { lens } = currentPose(layout.grid);
    const { width, height } = layout.grid;
    takeBite(lens.x, lens.y, Math.max(width, height));
  }, [currentPose, takeBite]);

  const bakeAnother = useCallback(() => {
    donutRef.current = bakeDonut();
    chompRef.current = null;
    crumbsRef.current = [];
    setBites(0);
    setLeft(100);
    setEaten(false);
    const layout = layoutRef.current;
    // The new donut grows out of the middle.
    startReveal(
      layout
        ? { x: layout.grid.width / 2, y: layout.grid.height / 2, size: 0 }
        : null,
    );
    canvasRef.current?.focus();
    wake();
  }, [startReveal, wake]);

  /** A pointer position in the canvas's own pixels, whatever its transform. */
  const canvasPoint = (canvas: HTMLCanvasElement, x: number, y: number) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? canvas.clientWidth / rect.width : 1;
    const scaleY = rect.height > 0 ? canvas.clientHeight / rect.height : 1;
    return { x: (x - rect.left) * scaleX, y: (y - rect.top) * scaleY };
  };

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
    const momentum = momentumRef.current;
    if (!drag.moved) {
      drag.moved = true;
      setDragging(true);
      // The hand holds the donut: no flick, no idle spin, until it lets go.
      momentum.x = 0;
      momentum.y = 0;
      momentum.idle = 0;
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
    momentum.x = momentum.x * 0.6 + ((dy * DRAG_TURN) / dt) * 0.4;
    momentum.y = momentum.y * 0.6 + ((dx * DRAG_TURN) / dt) * 0.4;
    wake();
  };

  const endDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null;
    if (!drag.moved) return;
    suppressClickRef.current = true;
    setDragging(false);
    const momentum = momentumRef.current;
    // A drag that stopped before release does not fling.
    const still = event.timeStamp - drag.at > 80;
    if (motionRef.current.reducedMotion || still) {
      momentum.x = 0;
      momentum.y = 0;
    } else {
      momentum.x = Math.max(-MAX_FLICK, Math.min(MAX_FLICK, momentum.x));
      momentum.y = Math.max(-MAX_FLICK, Math.min(MAX_FLICK, momentum.y));
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
      momentumRef.current = { x: 0, y: 0, idle: 0 };
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
      data-phase={phase}
      // Readable from the first frame: the entry only settles its scale.
      initial={motionAllowed ? { scale: 0.985 } : false}
      animate={{ scale: 1 }}
      transition={{ duration: MOTION_DURATION.base, ease: MOTION_EASE_OUT }}
      className="absolute inset-0 z-20 overflow-hidden rounded-[inherit] bg-background bg-[radial-gradient(circle_at_50%_50%,color-mix(in_oklab,var(--foreground)_7%,transparent),transparent_62%)]"
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
          const point = canvasPoint(
            event.currentTarget,
            event.clientX,
            event.clientY,
          );
          takeBite(
            point.x,
            point.y,
            Math.min(layout.grid.width, layout.grid.height) * 0.22,
          );
        }}
        onKeyDown={onKeyDown}
        className={cn(
          "absolute inset-0 size-full touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
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
