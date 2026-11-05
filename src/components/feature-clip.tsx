"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { TipId } from "@/lib/tips";
import { cn } from "@/lib/utils";

/** A recording of the app at work: one per tip, and two for the first run. */
export type ClipId = TipId | "welcome" | "newProfile";

/** Width over height of each recording; every tip clip is 2:1. */
export function clipAspect(id: ClipId): number {
  return id === "welcome" || id === "newProfile" ? 3 : 2;
}

function subscribeToMode(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

/** Every theme, custom ones too, puts `light` or `dark` on the root. */
function readMode(): "light" | "dark" {
  return document.documentElement.classList.contains("light")
    ? "light"
    : "dark";
}

/**
 * A short recording of the real app showing a feature in use, in the light
 * or dark take to match the theme. `pnpm clips` records them into
 * `public/clips`. The still frame is always underneath, so the box is never
 * empty while the animation loads; with reduced motion, or while `playing`
 * is false, only the still shows. Decorative: the copy beside it says
 * everything.
 */
export function FeatureClip({
  id,
  playing = true,
  className,
  onPointerEnter,
  onPointerLeave,
}: {
  id: ClipId;
  playing?: boolean;
  className?: string;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const mode = useSyncExternalStore(subscribeToMode, readMode, () => "dark");
  const reduceMotion = useReducedMotion() ?? false;
  const base = `/clips/${id}-${mode}`;
  // A webview that cannot decode WebP shows the empty panel, never a
  // broken-image glyph.
  const [failed, setFailed] = useState<string | null>(null);
  const shown = failed !== base;
  return (
    <div
      aria-hidden="true"
      data-slot="feature-clip"
      data-clip={id}
      className={cn("relative overflow-hidden", className)}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {shown && (
        // biome-ignore lint/performance/noImgElement: a static export serves the clips as they are
        <img
          src={`${base}-still.webp`}
          alt=""
          draggable={false}
          decoding="async"
          onError={() => setFailed(base)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
      <AnimatePresence initial={false}>
        {shown && playing && !reduceMotion && (
          // biome-ignore lint/performance/noImgElement: a static export serves the clips as they are
          <motion.img
            key={base}
            src={`${base}.webp`}
            alt=""
            draggable={false}
            decoding="async"
            loading="lazy"
            data-slot="feature-clip-motion"
            exit={{ opacity: 0, transition: { duration: 0.3 } }}
            className="absolute inset-0 size-full object-cover"
          />
        )}
      </AnimatePresence>
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-foreground/8 ring-inset" />
    </div>
  );
}

/** How long a resting clip plays before it settles on its still. */
const CLIP_PLAY_MS = 12_000;

/**
 * A clip that plays a few loops when it mounts, then rests on its still so
 * a page does not animate all day; the pointer over it plays it again.
 * `autoplay` false starts it at rest, `paused` holds it there.
 */
export function RestingClip({
  id,
  autoplay = true,
  paused = false,
  className,
}: {
  id: ClipId;
  autoplay?: boolean;
  paused?: boolean;
  className?: string;
}) {
  const [intro, setIntro] = useState(autoplay);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!autoplay) return;
    const timer = window.setTimeout(() => setIntro(false), CLIP_PLAY_MS);
    return () => window.clearTimeout(timer);
  }, [autoplay]);
  return (
    <FeatureClip
      id={id}
      playing={!paused && (intro || hovered)}
      className={className}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    />
  );
}
