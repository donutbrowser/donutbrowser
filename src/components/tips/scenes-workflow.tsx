"use client";

import { motion } from "motion/react";
import { Cursor, Scene, useScene } from "./scene-primitives";

/**
 * Scenes for the everyday tips. Decorative, like every scene: the text says
 * what the feature does, and the drawing shows it happening.
 */

const SEARCH_ROWS = [
  { y: 66, match: false, width: 62 },
  { y: 86, match: true, width: 44 },
  { y: 106, match: false, width: 70 },
  { y: 126, match: true, width: 52 },
  { y: 146, match: false, width: 38 },
];

/** A field token goes into the search box and the list narrows to its matches. */
export function SearchScene() {
  const { kf, tr } = useScene(4.8);
  const typing = tr([0, 0.1, 0.3, 1]);
  return (
    <Scene>
      <rect x={40} y={16} width={240} height={30} rx={9} />
      <circle cx={57} cy={31} r={5} />
      <path d="M61 35 l4 4" />
      <motion.rect
        x={74}
        y={22}
        height={18}
        rx={5}
        className="text-foreground"
        initial={false}
        animate={{ width: kf([0, 0, 74, 74]) }}
        transition={typing}
      />
      <motion.text
        x={111}
        y={31}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={10}
        fontFamily="ui-monospace, monospace"
        fill="currentColor"
        stroke="none"
        className="text-foreground"
        initial={false}
        animate={{ opacity: kf([0, 0, 1, 1]) }}
        transition={tr([0, 0.22, 0.3, 1])}
      >
        proxy:none
      </motion.text>
      <motion.path
        d="M76 24 v14"
        className="text-foreground"
        initial={false}
        animate={{ x: kf([0, 0, 78, 78]) }}
        transition={typing}
      />
      {SEARCH_ROWS.map((row) => (
        <motion.g
          key={row.y}
          className={row.match ? "text-foreground" : undefined}
          initial={false}
          animate={{ opacity: row.match ? 1 : kf([1, 1, 0.2, 0.2]) }}
          transition={tr([0, 0.38, 0.5, 1])}
        >
          <circle cx={56} cy={row.y} r={4} />
          <path d={`M68 ${row.y} h${row.width}`} strokeWidth={2} />
          {row.match ? (
            <rect
              x={232}
              y={row.y - 5}
              width={34}
              height={10}
              rx={5}
              strokeDasharray="2 3"
            />
          ) : (
            <path d={`M234 ${row.y} h30`} strokeWidth={2} />
          )}
        </motion.g>
      ))}
    </Scene>
  );
}

const KEY_ROWS = [0, 1, 2];
const KEY_COLUMNS = Array.from({ length: 9 }, (_, column) => column);

function keyX(column: number) {
  return 26 + column * 18;
}

function keyY(row: number) {
  return 58 + row * 18;
}

const CHORDS = [
  { row: 1, column: 4, at: 0.1, sheetRow: 0 },
  { row: 0, column: 6, at: 0.46, sheetRow: 2 },
];

/** Two chords light up on the keyboard; the sheet shows what each one does. */
export function ShortcutsScene() {
  const { kf, tr } = useScene(5);
  const light = (at: number) => ({
    animate: { opacity: kf([0, 0, 0.9, 0.9, 0, 0]) },
    transition: tr([0, at, at + 0.04, at + 0.22, at + 0.28, 1]),
  });
  return (
    <Scene>
      <rect x={16} y={48} width={178} height={96} rx={9} />
      {KEY_ROWS.map((row) =>
        KEY_COLUMNS.map((column) => (
          <rect
            key={`${row}-${column}`}
            x={keyX(column)}
            y={keyY(row)}
            width={14}
            height={13}
            rx={3}
          />
        )),
      )}
      <rect x={26} y={113} width={30} height={20} rx={4} />
      <rect x={62} y={113} width={92} height={20} rx={4} />
      <rect x={160} y={113} width={22} height={20} rx={4} />
      {CHORDS.map((chord) => (
        <g key={chord.at} className="text-foreground">
          <motion.rect
            x={26}
            y={113}
            width={30}
            height={20}
            rx={4}
            fill="currentColor"
            stroke="none"
            initial={false}
            {...light(chord.at)}
          />
          <motion.rect
            x={keyX(chord.column)}
            y={keyY(chord.row)}
            width={14}
            height={13}
            rx={3}
            fill="currentColor"
            stroke="none"
            initial={false}
            {...light(chord.at + 0.03)}
          />
        </g>
      ))}
      <rect x={210} y={26} width={94} height={118} rx={8} />
      {[0, 1, 2, 3].map((row) => (
        <g key={row}>
          <rect x={220} y={42 + row * 24} width={16} height={12} rx={3} />
          <path
            d={`M244 ${48 + row * 24} h${44 - (row % 2) * 14}`}
            strokeWidth={2}
          />
        </g>
      ))}
      <motion.rect
        x={215}
        y={37}
        width={84}
        height={22}
        rx={5}
        className="text-foreground"
        initial={false}
        animate={{ y: kf([0, 0, 0, 48, 48]) }}
        transition={tr([0, 0.14, 0.46, 0.52, 1])}
      />
    </Scene>
  );
}

const STATUS_ROWS = [34, 72, 110];
const STATUS_TONES = [
  "text-success-text",
  "text-warning-text",
  "text-destructive-text",
];

/** A status is picked from the row's menu and the row carries its color. */
export function StatusesScene() {
  const { kf, tr } = useScene(5.2);
  const menu = tr([0, 0.3, 0.36, 0.6, 0.66, 1]);
  return (
    <Scene>
      {STATUS_ROWS.map((y, index) => (
        <g key={y}>
          <rect x={20} y={y - 14} width={280} height={28} rx={6} />
          <circle cx={38} cy={y} r={6} />
          <path d={`M52 ${y} h${64 - index * 10}`} strokeWidth={2} />
          {index !== 1 && (
            <g className={index === 0 ? STATUS_TONES[0] : STATUS_TONES[2]}>
              <rect x={210} y={y - 8} width={74} height={16} rx={8} />
              <circle cx={221} cy={y} r={3} fill="currentColor" stroke="none" />
              <path d={`M230 ${y} h42`} strokeWidth={2} />
            </g>
          )}
        </g>
      ))}
      <motion.rect
        x={210}
        y={64}
        width={74}
        height={16}
        rx={8}
        strokeDasharray="2 4"
        initial={false}
        animate={{ opacity: kf([1, 1, 0, 0]) }}
        transition={tr([0, 0.64, 0.68, 1])}
      />
      <motion.g
        className={STATUS_TONES[1]}
        initial={false}
        animate={{ opacity: kf([0, 0, 1, 1]) }}
        transition={tr([0, 0.64, 0.7, 1])}
      >
        <rect x={210} y={64} width={74} height={16} rx={8} />
        <circle cx={221} cy={72} r={3} fill="currentColor" stroke="none" />
        <path d="M230 72 h42" strokeWidth={2} />
      </motion.g>
      <motion.g
        initial={false}
        animate={{
          opacity: kf([0, 0, 1, 1, 0, 0]),
          y: kf([-4, -4, 0, 0, -4, -4]),
        }}
        transition={menu}
      >
        <rect
          x={196}
          y={86}
          width={96}
          height={62}
          rx={7}
          className="fill-background"
        />
        {STATUS_TONES.map((tone, index) => (
          <g key={tone}>
            <circle
              cx={210}
              cy={100 + index * 17}
              r={3}
              fill="currentColor"
              stroke="none"
              className={tone}
            />
            <path
              d={`M220 ${100 + index * 17} h${50 - index * 8}`}
              strokeWidth={2}
            />
          </g>
        ))}
        <motion.rect
          x={201}
          y={91}
          width={86}
          height={18}
          rx={4}
          className="text-foreground"
          initial={false}
          animate={{ y: kf([0, 0, 17, 17]) }}
          transition={tr([0, 0.44, 0.52, 1])}
        />
      </motion.g>
      <Cursor
        className="text-foreground"
        animate={{
          x: kf([150, 150, 250, 250, 252, 252, 288, 288]),
          y: kf([140, 140, 74, 74, 118, 118, 80, 80]),
        }}
        transition={tr([0, 0.08, 0.26, 0.4, 0.5, 0.6, 0.76, 1])}
      />
    </Scene>
  );
}

const COPIES = [148, 200, 252];

/** Copies leave the template one by one, each with a new device of its own. */
export function TemplatesScene() {
  const { kf, tr } = useScene(4.8);
  return (
    <Scene>
      <g className="text-foreground">
        <rect x={20} y={36} width={92} height={88} rx={8} />
        <circle cx={40} cy={58} r={7} />
        <path d="M54 55 h38 M54 63 h24" strokeWidth={2} />
        <path d="M32 86 h64 M32 100 h48" strokeWidth={2} />
        <path d="M94 36 v14 l5 -4 l5 4 v-14" />
      </g>
      {COPIES.map((x, index) => {
        const at = 0.12 + index * 0.16;
        return (
          <motion.g
            key={x}
            initial={false}
            animate={{
              x: kf([20 - x, 20 - x, 0, 0]),
              opacity: kf([0, 0, 1, 1]),
            }}
            transition={tr([0, at, at + 0.18, 1])}
          >
            <rect x={x} y={48} width={48} height={64} rx={7} />
            <path d={`M${x + 10} 92 h28 M${x + 10} 102 h18`} strokeWidth={2} />
            <motion.circle
              cx={x + 24}
              cy={70}
              className="text-foreground"
              initial={false}
              animate={{ r: kf([0, 0, 8, 7, 7]) }}
              transition={tr([0, at + 0.2, at + 0.26, at + 0.3, 1])}
            />
          </motion.g>
        );
      })}
    </Scene>
  );
}
