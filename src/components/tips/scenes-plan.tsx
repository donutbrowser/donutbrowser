"use client";

import { motion } from "motion/react";
import { FaApple, FaLinux, FaWindows } from "react-icons/fa";
import {
  bezier,
  Check,
  Cloud,
  Cursor,
  Laptop,
  Monitor,
  Padlock,
  Person,
  Scene,
  travel,
  useScene,
  Window,
} from "./scene-primitives";

const UP = travel(
  bezier(
    { x: 82, y: 96 },
    { x: 100, y: 70 },
    { x: 120, y: 56 },
    { x: 140, y: 56 },
    8,
  ),
  0.08,
  0.34,
);
const DOWN = travel(
  bezier(
    { x: 180, y: 56 },
    { x: 200, y: 56 },
    { x: 220, y: 70 },
    { x: 238, y: 96 },
    8,
  ),
  0.44,
  0.7,
);

/** A profile goes up to the cloud from one machine and down to another. */
export function CloudSyncScene() {
  const { kf, tr } = useScene(4.4);
  return (
    <Scene>
      <Laptop x={24} y={78} />
      <Cloud cx={160} cy={52} />
      <Monitor x={238} y={74} />
      <path d="M82 96 C100 70 120 56 140 56" strokeDasharray="2 5" />
      <path d="M180 56 C200 56 220 70 238 96" strokeDasharray="2 5" />
      <motion.circle
        r={3.5}
        fill="currentColor"
        stroke="none"
        className="text-foreground"
        initial={false}
        animate={{ cx: kf(UP.cx), cy: kf(UP.cy) }}
        transition={tr(UP.times, { ease: "linear" })}
      />
      <motion.circle
        r={3.5}
        fill="currentColor"
        stroke="none"
        className="text-foreground"
        initial={false}
        animate={{ cx: kf(DOWN.cx), cy: kf(DOWN.cy) }}
        transition={tr(DOWN.times, { ease: "linear" })}
      />
      <Check
        x={260}
        y={92}
        className="text-success-text"
        animate={{ pathLength: kf([0, 0, 1, 1]) }}
        transition={tr([0, 0.72, 0.84, 1])}
      />
    </Scene>
  );
}

const DIAL = { cx: 62, cy: 80, r: 30 };
/** Where on the dial the day's run is scheduled, in degrees from 12. */
const RUN_AT = 135;
const SWEEP = Array.from({ length: 25 }, (_, step) => (step * 360) / 24);

function onDial(degrees: number, length: number) {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: DIAL.cx + Math.sin(radians) * length,
    y: DIAL.cy - Math.cos(radians) * length,
  };
}

/** The day turns on the dial; at the run's minute the profile fills with cookies. */
export function CookieBotScene() {
  const { kf, tr } = useScene(5.4);
  const hand = SWEEP.map((degrees) => onDial(degrees, DIAL.r - 8));
  const sweep = tr(
    SWEEP.map((_, step) => step / 24),
    { ease: "linear" },
  );
  const start = RUN_AT / 360;
  const mark = onDial(RUN_AT, DIAL.r);
  return (
    <Scene>
      <circle cx={DIAL.cx} cy={DIAL.cy} r={DIAL.r} />
      {[0, 90, 180, 270].map((degrees) => {
        const outer = onDial(degrees, DIAL.r - 2);
        const inner = onDial(degrees, DIAL.r - 6);
        return (
          <path
            key={degrees}
            d={`M${outer.x} ${outer.y} L${inner.x} ${inner.y}`}
          />
        );
      })}
      <motion.line
        x1={DIAL.cx}
        y1={DIAL.cy}
        strokeWidth={2}
        className="text-foreground"
        initial={false}
        animate={{
          x2: kf(hand.map((point) => point.x)),
          y2: kf(hand.map((point) => point.y)),
        }}
        transition={sweep}
      />
      <circle
        cx={DIAL.cx}
        cy={DIAL.cy}
        r={2}
        fill="currentColor"
        stroke="none"
        className="text-foreground"
      />
      <motion.circle
        cx={mark.x}
        cy={mark.y}
        fill="currentColor"
        stroke="none"
        className="text-foreground"
        initial={false}
        animate={{ r: kf([3, 3, 5, 3, 3]) }}
        transition={tr([0, start - 0.02, start + 0.02, start + 0.08, 1])}
      />
      <path d="M96 80 H118" strokeDasharray="2 5" />
      <Window x={118} y={34} width={186} height={92} lines={0}>
        {[0, 1, 2, 3, 4].map((index) => {
          const at = start + 0.06 + index * 0.08;
          const cx = 144 + index * 32;
          return (
            <g key={index}>
              <motion.circle
                cx={cx}
                cy={78}
                initial={false}
                animate={{ r: kf([0, 0, 8, 7, 7]) }}
                transition={tr([0, at, at + 0.05, at + 0.08, 1])}
              />
              <motion.g
                fill="currentColor"
                stroke="none"
                initial={false}
                animate={{ opacity: kf([0, 0, 1, 1]) }}
                transition={tr([0, at + 0.04, at + 0.08, 1])}
              >
                <circle cx={cx - 2.5} cy={76} r={1} />
                <circle cx={cx + 2} cy={80.5} r={1} />
              </motion.g>
            </g>
          );
        })}
        <motion.path
          d="M134 106 h154"
          strokeWidth={2}
          className="text-foreground"
          initial={false}
          animate={{ pathLength: kf([0, 0, 1, 1]) }}
          transition={tr([0, start + 0.04, start + 0.46, 1], {
            ease: "linear",
          })}
        />
      </Window>
    </Scene>
  );
}

const OS_MARKS = [FaApple, FaWindows, FaLinux];
const OS_TIMES = [0, 0.28, 0.34, 0.61, 0.67, 0.94, 1];
const OS_VISIBLE = [
  [1, 1, 0, 0, 0, 0, 1],
  [0, 0, 1, 1, 0, 0, 0],
  [0, 0, 0, 0, 1, 1, 0],
];

/** One profile presents as each operating system in turn. */
export function CrossOsScene() {
  const { kf, tr } = useScene(5.4);
  return (
    <Scene>
      <Window x={40} y={30} width={240} height={100} lines={3} />
      <rect x={214} y={54} width={52} height={52} rx={8} />
      {OS_MARKS.map((Mark, index) => (
        <motion.g
          key={Mark.name}
          className="text-foreground"
          initial={false}
          animate={{ opacity: kf(OS_VISIBLE[index]) }}
          transition={tr(OS_TIMES)}
        >
          <Mark x={226} y={66} width={28} height={28} stroke="none" />
        </motion.g>
      ))}
      <motion.path
        d="M222 114 h12"
        strokeWidth={2}
        className="text-foreground"
        initial={false}
        animate={{ x: kf([0, 0, 12, 12, 24, 24, 0]) }}
        transition={tr(OS_TIMES)}
      />
    </Scene>
  );
}

/** The agent asks, the person answers, and the agent carries on. */
export function AgentScene() {
  const { kf, tr } = useScene(5.6);
  return (
    <Scene>
      <g className="text-foreground">
        <rect x={20} y={60} width={36} height={28} rx={8} />
        <path d="M38 60 v-8" />
        <circle cx={38} cy={50} r={2} fill="currentColor" stroke="none" />
        <circle cx={31} cy={74} r={2.5} fill="currentColor" stroke="none" />
        <circle cx={45} cy={74} r={2.5} fill="currentColor" stroke="none" />
      </g>
      <Person cx={286} cy={82} />
      <motion.g
        initial={false}
        animate={{ opacity: kf([0, 0, 1, 1]), y: kf([6, 6, 0, 0]) }}
        transition={tr([0, 0.06, 0.14, 1])}
      >
        <rect x={70} y={22} width={118} height={30} rx={8} />
        <path d="M80 52 l-8 8 l16 -8" />
        <path d="M84 37 h62" strokeWidth={2} />
        <text
          x={170}
          y={37}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={15}
          fontFamily="inherit"
          fill="currentColor"
          stroke="none"
          className="text-foreground"
        >
          ?
        </text>
      </motion.g>
      <motion.g
        className="text-foreground"
        initial={false}
        animate={{ opacity: kf([0, 0, 1, 1]), y: kf([6, 6, 0, 0]) }}
        transition={tr([0, 0.3, 0.38, 1])}
      >
        <rect x={152} y={64} width={104} height={28} rx={8} />
        <path d="M246 92 l10 6 l-4 -6" />
        <motion.path
          d="M164 78 h72"
          strokeWidth={2}
          initial={false}
          animate={{ pathLength: kf([0, 0, 1, 1]) }}
          transition={tr([0, 0.38, 0.5, 1])}
        />
      </motion.g>
      <path d="M70 124 H246" strokeDasharray="2 5" />
      <motion.path
        d="M70 124 H246"
        strokeWidth={3}
        className="text-foreground"
        initial={false}
        animate={{ pathLength: kf([0, 0, 1, 1]) }}
        transition={tr([0, 0.56, 0.86, 1], { ease: "linear" })}
      />
      <Check
        x={256}
        y={124}
        className="text-success-text"
        animate={{ pathLength: kf([0, 0, 1, 1]) }}
        transition={tr([0, 0.86, 0.94, 1])}
      />
    </Scene>
  );
}

/** One teammate holds the profile lock, releases it, and the other takes it. */
export function TeamScene() {
  const { kf, tr } = useScene(5);
  return (
    <Scene>
      <Person cx={44} cy={84} />
      <Person cx={276} cy={84} />
      <Window x={112} y={48} width={96} height={64} lines={2} />
      <path d="M58 80 H112 M208 80 H262" />
      <motion.path
        d="M58 80 H112"
        className="text-foreground"
        strokeWidth={2.5}
        initial={false}
        animate={{ pathLength: kf([1, 1, 0, 0, 0]) }}
        transition={tr([0, 0.4, 0.5, 0.52, 1])}
      />
      <motion.path
        d="M262 80 H208"
        className="text-foreground"
        strokeWidth={2.5}
        initial={false}
        animate={{ pathLength: kf([0, 0, 0, 1, 1]) }}
        transition={tr([0, 0.55, 0.6, 0.72, 1])}
      />
      <Padlock
        x={152}
        y={116}
        className="text-foreground"
        shackle={{
          animate: { y: kf([0, 0, -5, -5, 0, 0]) },
          transition: tr([0, 0.42, 0.5, 0.62, 0.7, 1]),
        }}
      />
    </Scene>
  );
}

/** A request from the website crosses the bridge, drives the desktop, and reports back. */
export function RemoteScene() {
  const { kf, tr } = useScene(4.8);
  return (
    <Scene>
      <Cloud cx={64} cy={64} />
      <Monitor x={232} y={62} />
      <path d="M92 82 H232" strokeDasharray="2 5" />
      <motion.rect
        x={96}
        y={78}
        width={12}
        height={8}
        rx={2}
        className="text-foreground"
        initial={false}
        animate={{ x: kf([0, 0, 124, 124, 0, 0]) }}
        transition={tr([0, 0.08, 0.34, 0.56, 0.82, 1], { ease: "linear" })}
      />
      <Cursor
        className="text-foreground"
        animate={{ x: kf([246, 246, 268, 268]), y: kf([88, 88, 74, 74]) }}
        transition={tr([0, 0.36, 0.5, 1])}
      />
      <motion.circle
        cx={274}
        cy={80}
        className="text-foreground"
        initial={false}
        animate={{ r: kf([0, 0, 4, 7, 0, 0]) }}
        transition={tr([0, 0.5, 0.53, 0.58, 0.62, 1])}
      />
    </Scene>
  );
}

const LEADER = { x: 16, y: 24, width: 136, height: 112 };
const FOLLOWERS = [
  { x: 180, y: 24, width: 124, height: 52 },
  { x: 180, y: 84, width: 124, height: 52 },
];
type Frame = typeof LEADER;
/** Spots on the leader's page, from its top-left corner. */
const MOVES = [
  { x: 44, y: 76 },
  { x: 94, y: 46 },
  { x: 54, y: 86 },
];
const MOVE_PATH = [0, 0, 1, 1, 2, 2].map((index) => MOVES[index]);
const MOVE_TIMES = [0, 0.08, 0.3, 0.42, 0.62, 1];
const CLICKS = [
  { at: 0.32, spot: MOVES[1] },
  { at: 0.64, spot: MOVES[2] },
];

/** The same spot on a smaller page: followers scale the leader's moves. */
function place(frame: Frame, spot: { x: number; y: number }) {
  return {
    x: frame.x + (spot.x * frame.width) / LEADER.width,
    y: frame.y + (spot.y * frame.height) / LEADER.height,
  };
}

/** The leader clicks; both followers click the same spot at the same time. */
export function SynchronizerScene() {
  const { kf, tr } = useScene(4.8);
  return (
    <Scene>
      <Window {...LEADER} lines={4} className="text-foreground" />
      {FOLLOWERS.map((frame) => (
        <Window key={frame.y} {...frame} lines={1} />
      ))}
      <path d="M152 50 H180 M152 110 H180" strokeDasharray="2 5" />
      {[LEADER, ...FOLLOWERS].map((frame) => {
        const path = MOVE_PATH.map((spot) => place(frame, spot));
        return (
          <g key={`${frame.x}-${frame.y}`} className="text-foreground">
            {CLICKS.map(({ at, spot }) => {
              const point = place(frame, spot);
              return (
                <motion.circle
                  key={at}
                  cx={point.x}
                  cy={point.y}
                  initial={false}
                  animate={{ r: kf([0, 0, 3, 7, 0, 0]) }}
                  transition={tr([0, at, at + 0.03, at + 0.08, at + 0.12, 1])}
                />
              );
            })}
            <Cursor
              animate={{
                x: kf(path.map((point) => point.x)),
                y: kf(path.map((point) => point.y)),
              }}
              transition={tr(MOVE_TIMES)}
            />
          </g>
        );
      })}
    </Scene>
  );
}
