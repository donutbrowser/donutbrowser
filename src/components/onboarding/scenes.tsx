"use client";

import { motion, type Transition, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { Logo } from "@/components/icons/logo";
import {
  bezier,
  Check,
  Cursor,
  Globe,
  type Point,
  travel,
} from "@/components/tips/scene-primitives";
import { MOTION_EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The drawings of the first-run flow, one per step. They are decorative: the
 * text beside them says everything. Each one builds itself once (lines draw,
 * parts settle in order), loops a quiet detail a few times, and then rests on
 * its finished frame. Reduced motion shows the finished frame at once.
 */

const WIDE_W = 480;
const WIDE_H = 160;

/** How many times an ambient detail plays before the drawing rests. */
const AMBIENT_REPEATS = 4;

function useStage() {
  const reduce = useReducedMotion() ?? false;
  /** A one-shot entrance that starts `delay` seconds in. */
  const enter = (delay: number, duration = 0.7): Transition =>
    reduce ? { duration: 0 } : { delay, duration, ease: MOTION_EASE_OUT };
  const pop = (delay: number): Transition =>
    reduce
      ? { duration: 0 }
      : { delay, type: "spring", stiffness: 420, damping: 22, mass: 0.6 };
  /** A detail that repeats a few times, then rests on its last keyframe. */
  const ambient = (
    duration: number,
    delay: number,
    times: number[],
    extra?: Transition,
  ): Transition =>
    reduce
      ? { duration: 0 }
      : {
          duration,
          delay,
          times,
          repeat: AMBIENT_REPEATS,
          ease: "easeInOut",
          ...extra,
        };
  /** The resting value under reduced motion, every keyframe otherwise. */
  const kf = <T,>(values: T[]): T | T[] =>
    reduce ? (values[values.length - 1] as T) : values;
  return { reduce, enter, pop, ambient, kf };
}

function WideScene({
  children,
  className,
  slot,
}: {
  children: ReactNode;
  className?: string;
  slot: string;
}) {
  return (
    <svg
      data-slot="welcome-scene"
      data-scene={slot}
      viewBox={`0 0 ${WIDE_W} ${WIDE_H}`}
      className={cn("h-full w-full text-muted-foreground", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Three concentric arcs, a fingerprint at a glance; `turn` makes each one its own. */
function Fingerprint({
  cx,
  cy,
  turn,
  transition,
  drawn = true,
}: {
  cx: number;
  cy: number;
  turn: number;
  transition: Transition;
  drawn?: boolean;
}) {
  return (
    <g transform={`rotate(${turn} ${cx} ${cy})`}>
      {[3, 6, 9].map((r, index) => (
        <motion.path
          key={r}
          d={`M${cx - r} ${cy + 1} a${r} ${r} 0 1 1 ${r * 2} 0`}
          initial={drawn ? { pathLength: 0 } : false}
          animate={{ pathLength: 1 }}
          transition={{
            ...transition,
            delay:
              ((transition.delay as number | undefined) ?? 0) + index * 0.08,
          }}
        />
      ))}
    </g>
  );
}

const DONUT = { x: 104, y: 80 };
const WINDOWS = [
  { y: 14, turn: 0, pin: { x: -3, y: -2 } },
  { y: 62, turn: 70, pin: { x: 3, y: 1 } },
  { y: 110, turn: 150, pin: { x: -1, y: 4 } },
];
const WINDOW_X = 262;
const WINDOW_W = 186;
const WINDOW_H = 36;

function wire(y: number): [Point, Point, Point, Point] {
  return [
    { x: DONUT.x + 44, y: DONUT.y },
    { x: 200, y: DONUT.y },
    { x: 214, y: y + WINDOW_H / 2 },
    { x: WINDOW_X, y: y + WINDOW_H / 2 },
  ];
}

/**
 * One app, many browsers: wires run from the donut to three profile windows,
 * each window gets its own fingerprint and its own place on the map, and a
 * signal travels each wire on its own.
 */
export function IntroScene() {
  const { reduce, enter, pop, ambient, kf } = useStage();
  return (
    <WideScene slot="intro">
      <motion.circle
        cx={DONUT.x}
        cy={DONUT.y}
        r={42}
        className="text-foreground opacity-40"
        style={{ rotate: -90, originX: "50%", originY: "50%" }}
        initial={reduce ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={enter(0.15, 1.1)}
      />
      <motion.g
        className="text-foreground"
        style={{ originX: "50%", originY: "50%" }}
        // The mark is the one part of the drawing on its first frame.
        initial={reduce ? false : { scale: 0.6, rotate: -40, opacity: 0.5 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={
          reduce
            ? { duration: 0 }
            : { type: "spring", stiffness: 180, damping: 16, mass: 0.8 }
        }
      >
        <Logo
          x={DONUT.x - 32}
          y={DONUT.y - 32}
          width={64}
          height={64}
          aria-hidden="true"
        />
      </motion.g>

      {WINDOWS.map((profile, index) => {
        const points = wire(profile.y);
        const path = `M${points[0].x} ${points[0].y} C${points[1].x} ${points[1].y} ${points[2].x} ${points[2].y} ${points[3].x} ${points[3].y}`;
        const signal = travel(bezier(...points, 14), 0.08, 0.46);
        const start = 0.55 + index * 0.14;
        return (
          <g key={profile.y}>
            <motion.path
              d={path}
              initial={reduce ? false : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={enter(start, 0.6)}
            />
            <motion.g
              initial={reduce ? false : { x: -14, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={enter(start + 0.3, 0.6)}
            >
              <rect
                x={WINDOW_X}
                y={profile.y}
                width={WINDOW_W}
                height={WINDOW_H}
                rx={7}
                className="text-foreground"
              />
              {[0, 1, 2].map((dot) => (
                <circle
                  key={dot}
                  cx={WINDOW_X + 9 + dot * 6}
                  cy={profile.y + 8}
                  r={1.3}
                  fill="currentColor"
                  stroke="none"
                />
              ))}
              <g className="text-foreground">
                <Fingerprint
                  cx={WINDOW_X + 18}
                  cy={profile.y + 23}
                  turn={profile.turn}
                  drawn={!reduce}
                  transition={enter(start + 0.6, 0.5)}
                />
              </g>
              <path
                d={`M${WINDOW_X + 38} ${profile.y + 18} h${64 - index * 10}`}
                strokeWidth={2}
              />
              <path
                d={`M${WINDOW_X + 38} ${profile.y + 27} h${40 + index * 8}`}
                strokeWidth={2}
                className="opacity-60"
              />
              <g className="text-foreground">
                <Globe
                  cx={WINDOW_X + WINDOW_W - 20}
                  cy={profile.y + WINDOW_H / 2}
                  r={9}
                />
              </g>
              <motion.circle
                cx={WINDOW_X + WINDOW_W - 20 + profile.pin.x}
                cy={profile.y + WINDOW_H / 2 + profile.pin.y}
                r={2.4}
                fill="currentColor"
                stroke="none"
                className="text-foreground"
                initial={reduce ? false : { scale: 0 }}
                animate={{ scale: 1 }}
                style={{ originX: "50%", originY: "50%" }}
                transition={pop(start + 0.9)}
              />
            </motion.g>
            {!reduce && (
              <motion.circle
                r={3}
                fill="currentColor"
                stroke="none"
                className="text-foreground"
                initial={{ opacity: 0, cx: signal.cx[0], cy: signal.cy[0] }}
                animate={{
                  cx: signal.cx,
                  cy: signal.cy,
                  opacity: kf(
                    signal.times.map((t) => (t > 0.06 && t < 0.48 ? 1 : 0)),
                  ),
                }}
                transition={ambient(3.4, 2 + index * 0.5, signal.times, {
                  ease: "linear",
                  repeatDelay: 0.6,
                })}
              />
            )}
          </g>
        );
      })}
    </WideScene>
  );
}

const LEMNISCATE = [
  ...bezier(
    { x: 130, y: 96 },
    { x: 150, y: 116 },
    { x: 180, y: 116 },
    { x: 180, y: 96 },
    8,
  ),
  ...bezier(
    { x: 180, y: 96 },
    { x: 180, y: 76 },
    { x: 150, y: 76 },
    { x: 130, y: 96 },
    8,
  ).slice(1),
  ...bezier(
    { x: 130, y: 96 },
    { x: 110, y: 116 },
    { x: 80, y: 116 },
    { x: 80, y: 96 },
    8,
  ).slice(1),
  ...bezier(
    { x: 80, y: 96 },
    { x: 80, y: 76 },
    { x: 110, y: 76 },
    { x: 130, y: 96 },
    8,
  ).slice(1),
];
const LOOP = travel(LEMNISCATE, 0, 1);
const CALENDAR = Array.from({ length: 14 }, (_, day) => ({
  day,
  x: 290 + (day % 7) * 20,
  y: 78 + Math.floor(day / 7) * 20,
}));

/**
 * Personal use runs on forever, a signal circling an infinity loop; the
 * commercial trial fills its two weeks day by day and ends on a check.
 */
export function LicenseScene() {
  const { reduce, enter, ambient, kf } = useStage();
  return (
    <WideScene slot="license">
      <motion.g
        initial={reduce ? false : { y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={enter(0.05, 0.6)}
      >
        <rect x={40} y={22} width={180} height={116} rx={12} />
        <motion.path
          d="M60 46 c-4-5-12-4-12 3 c0 6 8 10 12 13 c4-3 12-7 12-13 c0-7-8-8-12-3z"
          className="text-success-text"
          fill="currentColor"
          fillOpacity={0.18}
          initial={false}
          animate={{ scale: kf([1, 1.14, 1, 1.08, 1]) }}
          style={{ originX: "50%", originY: "50%" }}
          transition={ambient(1.4, 1.2, [0, 0.15, 0.3, 0.45, 1], {
            repeatDelay: 1.4,
          })}
        />
        <path d="M86 50 h56" strokeWidth={2} className="text-foreground" />
        <path d="M86 60 h34" strokeWidth={2} />
        <motion.path
          d="M130 96 C150 116 180 116 180 96 C180 76 150 76 130 96 C110 116 80 116 80 96 C80 76 110 76 130 96 Z"
          strokeWidth={2}
          className="text-foreground"
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={enter(0.4, 1.2)}
        />
        {!reduce && (
          <motion.circle
            r={3.2}
            fill="currentColor"
            stroke="none"
            className="text-foreground"
            initial={{ cx: LOOP.cx[0], cy: LOOP.cy[0], opacity: 0 }}
            animate={{ cx: LOOP.cx, cy: LOOP.cy, opacity: 1 }}
            transition={{
              cx: ambient(3.2, 1.6, LOOP.times, {
                ease: "linear",
                repeatDelay: 0,
              }),
              cy: ambient(3.2, 1.6, LOOP.times, {
                ease: "linear",
                repeatDelay: 0,
              }),
              opacity: enter(1.6, 0.3),
            }}
          />
        )}
      </motion.g>

      <motion.g
        initial={reduce ? false : { y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={enter(0.18, 0.6)}
      >
        <rect x={260} y={22} width={180} height={116} rx={12} />
        <g className="text-foreground">
          <rect x={278} y={40} width={20} height={15} rx={3} />
          <path d="M284 40 v-3 h8 v3 M278 47 h20" />
        </g>
        <path d="M308 44 h56" strokeWidth={2} className="text-foreground" />
        <path d="M308 54 h34" strokeWidth={2} />
        {CALENDAR.map(({ day, x, y }) => {
          const at = 0.04 + day * 0.048;
          return (
            <g key={day}>
              <rect
                x={x}
                y={y}
                width={14}
                height={14}
                rx={4}
                className="opacity-50"
              />
              <motion.rect
                x={x}
                y={y}
                width={14}
                height={14}
                rx={4}
                fill="currentColor"
                stroke="none"
                className="text-foreground"
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: kf([0, 0, 0.85, 0.85]) }}
                transition={ambient(3.2, 0.8, [0, at, at + 0.05, 1], {
                  repeatType: "mirror",
                  repeatDelay: 0.5,
                })}
              />
            </g>
          );
        })}
        <motion.g
          className="text-success-text"
          initial={reduce ? false : { scale: 0 }}
          animate={{ scale: kf([0, 0, 1, 1]) }}
          style={{ originX: "50%", originY: "50%" }}
          transition={ambient(3.2, 0.8, [0, 0.74, 0.84, 1], {
            repeatType: "mirror",
            repeatDelay: 0.5,
          })}
        >
          <circle
            cx={424}
            cy={38}
            r={9}
            fill="currentColor"
            fillOpacity={0.16}
          />
          <path d="M419.5 38.5 l3 3 l6 -6" strokeWidth={2} />
        </motion.g>
      </motion.g>
    </WideScene>
  );
}

/**
 * A site asks for the microphone and the camera; a click allows it and both
 * come alive. The loop starts and ends on the allowed frame, so it can rest
 * there and never jumps between rounds.
 */
export function PermissionsScene() {
  const { reduce, enter, ambient, kf } = useStage();
  const cycle = (times: number[]) =>
    ambient(5.6, 1, times, { repeatDelay: 0.8 });
  const CLICK = [0, 0.1, 0.12, 0.22, 0.34, 0.4, 0.46, 1];
  return (
    <WideScene slot="permissions">
      <motion.g
        initial={reduce ? false : { y: 8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={enter(0.05, 0.6)}
      >
        <rect x={104} y={14} width={272} height={132} rx={10} />
        <path d="M104 34 H376" />
        {[0, 1, 2].map((dot) => (
          <circle
            key={dot}
            cx={116 + dot * 7}
            cy={24}
            r={1.6}
            fill="currentColor"
            stroke="none"
          />
        ))}
        <rect
          x={150}
          y={20}
          width={120}
          height={8}
          rx={4}
          className="opacity-60"
        />
        <path
          d="M124 52 h70 M124 64 h52 M124 120 h96 M124 132 h60"
          strokeWidth={2}
          className="opacity-60"
        />
        <motion.circle
          cx={362}
          cy={24}
          r={3.2}
          fill="currentColor"
          stroke="none"
          className="text-destructive-text"
          initial={false}
          animate={{ opacity: kf([1, 0, 0, 0, 0, 0, 1, 1]) }}
          transition={cycle(CLICK)}
        />
      </motion.g>

      <motion.g
        initial={reduce ? false : { y: -8, scale: 0.94, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        style={{ originX: "50%", originY: "0%" }}
        transition={enter(0.35, 0.6)}
      >
        <rect
          x={214}
          y={44}
          width={146}
          height={70}
          rx={9}
          className="text-foreground"
          style={{ fill: "var(--background)" }}
        />
        <g className="text-foreground">
          <rect x={229} y={56} width={10} height={16} rx={5} />
          <path d="M226 66 a8 8 0 0 0 16 0 M234 74 v4" />
          <rect x={252} y={60} width={18} height={12} rx={3} />
          <path d="M270 64 l6 -3 v10 l-6 -3" />
        </g>
        <path d="M286 62 h56 M286 71 h38" strokeWidth={2} />
        <rect x={226} y={88} width={52} height={16} rx={5} />
        <motion.rect
          x={290}
          y={88}
          width={58}
          height={16}
          rx={5}
          fill="currentColor"
          className="text-foreground"
          initial={false}
          animate={{
            scale: kf([1, 1, 1, 1, 1, 0.92, 1, 1]),
            opacity: kf([0.9, 0.25, 0.25, 0.25, 0.25, 0.5, 0.9, 0.9]),
          }}
          style={{ originX: "50%", originY: "50%" }}
          transition={cycle(CLICK)}
        />
      </motion.g>

      {[0, 1, 2].map((wave) => (
        <motion.path
          key={wave}
          d={`M${206 - wave * 8} ${55 - wave * 4} a${12 + wave * 6} ${12 + wave * 6} 0 0 0 0 ${22 + wave * 8}`}
          className="text-foreground"
          initial={false}
          animate={{
            opacity: kf([
              0.8 - wave * 0.2,
              0,
              0,
              0.8 - wave * 0.2,
              0.8 - wave * 0.2,
            ]),
          }}
          transition={cycle([
            0,
            0.1,
            0.48 + wave * 0.05,
            0.56 + wave * 0.05,
            1,
          ])}
        />
      ))}
      <g className="text-foreground">
        <Cursor
          animate={{
            x: kf([318, 318, 420, 420, 318, 318, 318, 318]),
            y: kf([96, 96, 150, 150, 96, 98, 96, 96]),
            opacity: kf([1, 0, 0, 1, 1, 1, 1, 1]),
          }}
          transition={cycle(CLICK)}
        />
      </g>
    </WideScene>
  );
}

const PACKET_PATH = bezier(
  { x: 132, y: 72 },
  { x: 168, y: 52 },
  { x: 186, y: 62 },
  { x: 206, y: 74 },
  10,
);
const PACKET = travel(PACKET_PATH, 0, 1);

/**
 * The browser download, drawn from the real progress: packets travel from
 * the cloud into a ring that fills with the download; unpacking draws the
 * globe in; when it is ready the ring closes, a check lands and the first
 * profile's window slides out.
 */
export function SetupScene({
  phase,
  progress,
}: {
  phase: "downloading" | "extracting" | "ready" | "error";
  /** 0 to 100, for the current phase. */
  progress: number;
}) {
  const { reduce, enter, pop } = useStage();
  const ready = phase === "ready";
  const failed = phase === "error";
  const fill =
    phase === "ready"
      ? 1
      : phase === "downloading"
        ? Math.max(0.03, progress / 100)
        : phase === "extracting"
          ? 1
          : 0.25;
  const globe = ready
    ? 1
    : phase === "extracting"
      ? Math.max(0.1, progress / 100)
      : 0.15;
  const settle: Transition = reduce
    ? { duration: 0 }
    : { type: "spring", stiffness: 120, damping: 24 };
  return (
    <WideScene slot="setup">
      <motion.g
        initial={reduce ? false : { x: -10, opacity: 0 }}
        animate={{ x: 0, opacity: ready ? 0.4 : 1 }}
        transition={enter(0.05, 0.6)}
      >
        <path d="M86 86 a12 12 0 0 1 3 -23 a18 18 0 0 1 34 -6 a13 13 0 0 1 8 25 z" />
        <path d="M108 70 v14 m-5 -5 l5 5 l5 -5" className="text-foreground" />
      </motion.g>
      {phase === "downloading" &&
        !reduce &&
        [0, 1, 2].map((packet) => (
          <motion.circle
            key={packet}
            r={2.6}
            fill="currentColor"
            stroke="none"
            className="text-foreground"
            initial={{ cx: PACKET.cx[0], cy: PACKET.cy[0], opacity: 0 }}
            animate={{
              cx: PACKET.cx,
              cy: PACKET.cy,
              opacity: PACKET.times.map((t) => (t < 0.08 || t > 0.94 ? 0 : 1)),
            }}
            transition={{
              duration: 1.5,
              times: PACKET.times,
              ease: "linear",
              repeat: Number.POSITIVE_INFINITY,
              delay: packet * 0.5,
            }}
          />
        ))}
      <path
        d="M132 72 C168 52 186 62 206 74"
        strokeDasharray="2 5"
        className={cn(ready && "opacity-40")}
      />

      <circle cx={240} cy={80} r={38} className="opacity-40" strokeWidth={3} />
      <motion.circle
        cx={240}
        cy={80}
        r={38}
        strokeWidth={3}
        className={failed ? "text-destructive-text" : "text-foreground"}
        style={{ rotate: -90, originX: "50%", originY: "50%" }}
        initial={reduce ? false : { pathLength: 0 }}
        animate={{ pathLength: fill }}
        transition={settle}
      />
      {phase === "extracting" && !reduce && (
        <motion.circle
          cx={240}
          cy={80}
          r={44}
          strokeDasharray="3 9"
          className="opacity-50"
          initial={false}
          animate={{ rotate: 360 }}
          style={{ originX: "50%", originY: "50%" }}
          transition={{
            duration: 14,
            ease: "linear",
            repeat: Number.POSITIVE_INFINITY,
          }}
        />
      )}
      <g className={failed ? "text-destructive-text" : "text-foreground"}>
        <motion.circle
          cx={240}
          cy={80}
          r={20}
          initial={false}
          animate={{ pathLength: Math.max(0.2, globe) }}
          transition={settle}
        />
        <motion.ellipse
          cx={240}
          cy={80}
          rx={8.4}
          ry={20}
          initial={false}
          animate={{ pathLength: globe }}
          transition={settle}
        />
        <motion.path
          d="M220 80 h40 M222.8 70 q17.2 5.6 34.4 0 M222.8 90 q17.2 -5.6 34.4 0"
          initial={false}
          animate={{ pathLength: globe }}
          transition={settle}
        />
      </g>

      {ready && (
        <>
          {Array.from({ length: 8 }, (_, ray) => {
            const angle = (ray * Math.PI) / 4;
            const x1 = 240 + Math.cos(angle) * 50;
            const y1 = 80 + Math.sin(angle) * 50;
            const x2 = 240 + Math.cos(angle) * 60;
            const y2 = 80 + Math.sin(angle) * 60;
            return (
              <motion.path
                key={ray}
                d={`M${x1} ${y1} L${x2} ${y2}`}
                strokeWidth={2}
                className="text-foreground"
                initial={reduce ? false : { pathLength: 0, opacity: 1 }}
                animate={
                  reduce
                    ? { opacity: 0 }
                    : { pathLength: [0, 1, 1], opacity: [1, 1, 0] }
                }
                transition={
                  reduce
                    ? { duration: 0 }
                    : {
                        duration: 0.9,
                        times: [0, 0.4, 1],
                        ease: MOTION_EASE_OUT,
                        delay: 0.15,
                      }
                }
              />
            );
          })}
          <motion.g
            className="text-success-text"
            initial={reduce ? false : { scale: 0 }}
            animate={{ scale: 1 }}
            style={{ originX: "50%", originY: "50%" }}
            transition={pop(0.2)}
          >
            <circle
              cx={268}
              cy={52}
              r={10}
              style={{ fill: "var(--background)" }}
            />
            <circle
              cx={268}
              cy={52}
              r={10}
              fill="currentColor"
              fillOpacity={0.16}
            />
            <Check
              x={263}
              y={52.5}
              size={10}
              animate={{ pathLength: 1 }}
              transition={enter(0.35, 0.4)}
            />
          </motion.g>
          <motion.g
            initial={reduce ? false : { x: -24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={enter(0.45, 0.7)}
          >
            <rect
              x={318}
              y={54}
              width={124}
              height={52}
              rx={8}
              className="text-foreground"
            />
            <path d="M318 68 h124" />
            <circle
              cx={327}
              cy={61}
              r={1.4}
              fill="currentColor"
              stroke="none"
            />
            <circle
              cx={333}
              cy={61}
              r={1.4}
              fill="currentColor"
              stroke="none"
            />
            <g className="text-foreground">
              <Fingerprint
                cx={334}
                cy={88}
                turn={30}
                drawn={!reduce}
                transition={enter(0.9, 0.5)}
              />
            </g>
            <path d="M352 84 h56 M352 93 h36" strokeWidth={2} />
          </motion.g>
          <motion.path
            d="M290 80 h22"
            strokeDasharray="2 4"
            initial={reduce ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={enter(0.4, 0.4)}
          />
        </>
      )}
    </WideScene>
  );
}

/**
 * A click on New and a fresh profile slides out, with its own fingerprint.
 * Each round starts and ends on the finished frame.
 */
export function NewProfileScene() {
  const { reduce, enter, ambient, kf } = useStage();
  const cycle = (times: number[]) =>
    ambient(4.8, 0.4, times, { repeatDelay: 0.8 });
  return (
    <svg
      data-slot="tour-scene"
      viewBox="0 0 320 160"
      className="h-full w-full text-muted-foreground"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <motion.g
        className="text-foreground"
        initial={false}
        animate={{ scale: kf([1, 1, 1, 0.92, 1, 1]) }}
        style={{ originX: "50%", originY: "50%" }}
        transition={cycle([0, 0.1, 0.22, 0.27, 0.32, 1])}
      >
        <rect
          x={28}
          y={66}
          width={70}
          height={28}
          rx={8}
          fill="currentColor"
          fillOpacity={0.1}
        />
        <path d="M44 80 h10 M49 75 v10" strokeWidth={2} />
        <path d="M62 80 h24" strokeWidth={2} />
      </motion.g>
      <motion.path
        d="M98 80 C128 80 132 80 150 80"
        strokeDasharray="2 4"
        initial={false}
        animate={{ pathLength: kf([1, 0, 0, 0, 1, 1]) }}
        transition={cycle([0, 0.1, 0.12, 0.3, 0.42, 1])}
      />
      <motion.g
        initial={false}
        animate={{
          x: kf([0, 0, -30, -30, 0, 0]),
          opacity: kf([1, 0, 0, 0, 1, 1]),
          scale: kf([1, 1, 0.92, 0.92, 1, 1]),
        }}
        style={{ originX: "0%", originY: "50%" }}
        transition={cycle([0, 0.1, 0.12, 0.32, 0.5, 1])}
      >
        <rect
          x={156}
          y={34}
          width={140}
          height={92}
          rx={10}
          className="text-foreground"
        />
        <path d="M156 54 h140" />
        {[0, 1, 2].map((dot) => (
          <circle
            key={dot}
            cx={168 + dot * 7}
            cy={44}
            r={1.6}
            fill="currentColor"
            stroke="none"
          />
        ))}
        <g className="text-foreground">
          <Fingerprint
            cx={182}
            cy={84}
            turn={20}
            drawn={!reduce}
            transition={enter(0.6, 0.5)}
          />
        </g>
        <path d="M202 78 h64 M202 90 h42" strokeWidth={2} />
        <Globe cx={276} cy={110} r={8} />
      </motion.g>
      <g className="text-foreground">
        <Cursor
          animate={{
            x: kf([72, 72, 120, 120, 70, 70, 72, 72]),
            y: kf([84, 84, 130, 130, 84, 86, 84, 84]),
            opacity: kf([1, 0, 0, 1, 1, 1, 1, 1]),
          }}
          transition={cycle([0, 0.08, 0.1, 0.14, 0.24, 0.27, 0.32, 1])}
        />
      </g>
    </svg>
  );
}
