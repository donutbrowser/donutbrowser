"use client";

import { motion } from "motion/react";
import {
  bezier,
  Check,
  Globe,
  Laptop,
  Padlock,
  Scene,
  travel,
  useScene,
  Window,
} from "./scene-primitives";

/** Packets cross a sealed tunnel from this device to the exit. */
export function VpnScene() {
  const { kf, tr } = useScene(4.4);
  return (
    <Scene>
      <Laptop x={20} y={86} />
      <rect x={84} y={92} width={154} height={26} rx={13} />
      <path d="M96 105 H226" strokeDasharray="2 6" />
      <Padlock
        x={153}
        y={70}
        className="text-foreground"
        shackle={{
          animate: { y: kf([-5, -5, 0, 0]) },
          transition: tr([0, 0.06, 0.16, 1]),
        }}
      />
      {[0.2, 0.34, 0.48].map((at) => (
        <motion.rect
          key={at}
          y={101}
          width={12}
          height={8}
          rx={2}
          className="text-foreground"
          fill="currentColor"
          stroke="none"
          initial={false}
          animate={{
            x: kf([92, 92, 92, 218, 218, 218]),
            opacity: kf([0, 0, 1, 1, 0, 0]),
          }}
          transition={tr([0, at - 0.02, at, at + 0.3, at + 0.32, 1], {
            ease: "linear",
          })}
        />
      ))}
      <Globe cx={274} cy={105} r={20} />
      <Check
        x={282}
        y={74}
        className="text-success-text"
        animate={{ pathLength: kf([0, 0, 1, 1]) }}
        transition={tr([0, 0.8, 0.9, 1])}
      />
    </Scene>
  );
}

const DIRECT = { from: 96, stop: 166 };
const ROUTED = travel(
  [
    ...bezier(
      { x: 96, y: 78 },
      { x: 128, y: 78 },
      { x: 140, y: 38 },
      { x: 166, y: 38 },
      8,
    ),
    ...bezier(
      { x: 186, y: 38 },
      { x: 214, y: 38 },
      { x: 236, y: 82 },
      { x: 262, y: 92 },
      8,
    ),
  ],
  0.46,
  0.8,
);

/** The direct way out is refused; the launch goes through the proxy instead. */
export function RequireRouteScene() {
  const { kf, tr } = useScene(5);
  return (
    <Scene>
      <Window x={16} y={52} width={80} height={66} lines={2} />
      <path d="M96 104 H260" strokeDasharray="2 5" />
      <path d="M96 78 C128 78 140 38 166 38" />
      <path d="M186 38 C214 38 236 82 262 92" />
      <g className="text-foreground">
        <circle cx={176} cy={38} r={10} />
        <circle cx={176} cy={38} r={2} fill="currentColor" stroke="none" />
      </g>
      <Globe cx={280} cy={100} r={18} />
      <rect x={170} y={92} width={10} height={24} rx={3} />
      <motion.circle
        cy={104}
        fill="currentColor"
        stroke="none"
        className="text-foreground"
        initial={false}
        animate={{
          cx: kf([DIRECT.from, DIRECT.from, DIRECT.stop, DIRECT.stop]),
          r: kf([3.5, 3.5, 3.5, 0]),
        }}
        transition={tr([0, 0.06, 0.24, 0.3])}
      />
      <motion.path
        d="M171 124 l8 8 M179 124 l-8 8"
        className="text-destructive-text"
        initial={false}
        animate={{ pathLength: kf([0, 0, 1, 1]) }}
        transition={tr([0, 0.24, 0.34, 1])}
      />
      <motion.g
        initial={false}
        animate={{ opacity: kf([0, 0, 1, 1]) }}
        transition={tr([0, 0.45, 0.46, 1])}
      >
        <motion.circle
          r={3.5}
          fill="currentColor"
          stroke="none"
          className="text-foreground"
          initial={false}
          animate={{ cx: kf(ROUTED.cx), cy: kf(ROUTED.cy) }}
          transition={tr(ROUTED.times, { ease: "linear" })}
        />
      </motion.g>
      <Check
        x={288}
        y={70}
        className="text-success-text"
        animate={{ pathLength: kf([0, 0, 1, 1]) }}
        transition={tr([0, 0.82, 0.92, 1])}
      />
    </Scene>
  );
}

const CODE_A = "482913";
const CODE_B = "175026";

/** The code turns over as its ring runs out; the key stays sealed here. */
export function TotpScene() {
  const { kf, tr } = useScene(6);
  const cycle = [0, 0.48, 0.5, 0.98, 1];
  return (
    <Scene>
      <Window x={52} y={22} width={216} height={116} lines={0}>
        <path d="M68 50 h56" strokeWidth={2} />
        {[CODE_A, CODE_B].map((code, set) => (
          <motion.g
            key={code}
            className="text-foreground"
            initial={false}
            animate={{
              opacity: kf(set === 0 ? [1, 1, 0, 0, 1] : [0, 0, 1, 1, 0]),
            }}
            transition={tr(cycle, { ease: "linear" })}
          >
            {code.split("").map((digit, index) => (
              <text
                key={`${code}-${index}`}
                data-scene-keep=""
                x={78 + index * 22 + (index > 2 ? 10 : 0)}
                y={82}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={20}
                fontFamily="ui-monospace, monospace"
                fill="currentColor"
                stroke="none"
              >
                {digit}
              </text>
            ))}
          </motion.g>
        ))}
        <circle cx={240} cy={82} r={11} />
        <motion.circle
          cx={240}
          cy={82}
          r={11}
          strokeWidth={2.5}
          className="text-foreground"
          initial={false}
          animate={{ pathLength: kf([1, 0.02, 1, 0.02, 1]) }}
          transition={tr(cycle, { ease: "linear" })}
        />
        <Padlock x={68} y={112} className="text-foreground" />
        <path d="M92 118 h96" strokeWidth={2} />
      </Window>
    </Scene>
  );
}
