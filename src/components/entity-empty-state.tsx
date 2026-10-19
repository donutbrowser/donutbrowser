"use client";

import { motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import {
  Globe,
  Laptop,
  Padlock,
  Puzzle,
  puzzlePath,
  Scene,
  ScenePlayback,
  Server,
  travel,
  useScene,
  Window,
} from "@/components/tips/scene-primitives";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";

/** The drawing plays this long, then rests until the pointer comes over it. */
const SCENE_PLAY_MS = 12_000;

/**
 * What a page shows before its first entry: what the thing is for, and the
 * one action that makes the first one. The drawing is decorative: it plays a
 * few loops, then rests on its last frame.
 */
export function EntityEmptyState({
  entity,
  scene,
  title,
  description,
  children,
}: {
  entity: string;
  scene: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  const animate = useMotionAllowed();
  const [intro, setIntro] = useState(true);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setIntro(false), SCENE_PLAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <motion.div
      data-slot="entity-empty-state"
      data-entity={entity}
      initial={animate ? { opacity: 0.5, transform: "translateY(8px)" } : false}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={{ duration: MOTION_DURATION.slow, ease: MOTION_EASE_OUT }}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center"
    >
      <div
        aria-hidden="true"
        className="h-28 w-56 shrink-0"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <ScenePlayback playing={intro || hovered}>{scene}</ScenePlayback>
      </div>
      <div className="flex max-w-sm flex-col gap-1.5">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        <p className="text-xs leading-relaxed text-pretty text-muted-foreground">
          {description}
        </p>
      </div>
      {children && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {children}
        </div>
      )}
    </motion.div>
  );
}

const TUNNEL = travel(
  Array.from({ length: 12 }, (_, index) => ({ x: 80 + index * 17, y: 104 })),
  0.2,
  0.74,
);

/** The tunnel locks, then traffic crosses it sealed and leaves at the far end. */
export function VpnTunnelScene() {
  const { kf, tr } = useScene(3.6);
  return (
    <Scene>
      <Laptop x={16} y={86} />
      <rect x={86} y={92} width={124} height={24} rx={12} />
      <path d="M98 104 H198" strokeDasharray="2 5" />
      <Padlock
        x={140}
        y={62}
        className="text-foreground"
        shackle={{
          animate: { y: kf([-4, -4, 0, 0]) },
          transition: tr([0, 0.06, 0.14, 1]),
        }}
      />
      <motion.circle
        r={3.5}
        fill="currentColor"
        stroke="none"
        className="text-foreground"
        initial={false}
        animate={{ cx: kf(TUNNEL.cx), cy: kf(TUNNEL.cy) }}
        transition={tr(TUNNEL.times, { ease: "linear" })}
      />
      <Server x={218} y={76} />
      <path d="M258 104 H270" />
      <Globe cx={286} cy={104} r={16} />
      <motion.circle
        cx={286}
        cy={104}
        r={16}
        className="text-foreground"
        initial={false}
        animate={{ opacity: kf([0, 0, 1, 0, 0]) }}
        transition={tr([0, 0.74, 0.8, 0.92, 1])}
      />
    </Scene>
  );
}

const ARC = {
  from: { x: 96, y: 92 },
  via: { x: 190, y: 0 },
  to: { x: 284, y: 80 },
};

const DROP = travel(
  Array.from({ length: 12 }, (_, index) => {
    const t = index / 11;
    const mt = 1 - t;
    return {
      x: mt * mt * ARC.from.x + 2 * mt * t * ARC.via.x + t * t * ARC.to.x,
      y: mt * mt * ARC.from.y + 2 * mt * t * ARC.via.y + t * t * ARC.to.y,
    };
  }),
  0.2,
  0.62,
);

/** A package crosses into the browser and its piece appears in the toolbar. */
export function ExtensionDropScene() {
  const { kf, tr } = useScene(3.8);
  return (
    <Scene>
      <path d="M24 52 h42 l14 14 v62 h-56 z M66 52 v14 h14" />
      <Puzzle x={38} y={82} size={28} className="text-foreground" />
      <path
        d={`M${ARC.from.x} ${ARC.from.y} Q${ARC.via.x} ${ARC.via.y} ${ARC.to.x} ${ARC.to.y}`}
        strokeDasharray="2 5"
      />
      <Window x={176} y={84} width={128} height={60} lines={2} />
      <motion.circle
        r={3.5}
        fill="currentColor"
        stroke="none"
        className="text-foreground"
        initial={false}
        animate={{ cx: kf(DROP.cx), cy: kf(DROP.cy) }}
        transition={tr(DROP.times, { ease: "linear" })}
      />
      <motion.path
        d={puzzlePath(279, 88, 10)}
        className="text-foreground"
        initial={false}
        animate={{ pathLength: kf([0, 0, 1, 1]) }}
        transition={tr([0, 0.64, 0.78, 1])}
      />
    </Scene>
  );
}
