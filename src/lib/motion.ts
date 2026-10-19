export const MOTION_EASE_OUT: [number, number, number, number] = [
  0.23, 1, 0.32, 1,
];

export const MOTION_EASE_IN: [number, number, number, number] = [
  0.5, 0, 0.75, 0,
];

export const MOTION_SPRING_POSITION = {
  type: "spring" as const,
  stiffness: 500,
  damping: 30,
  mass: 0.5,
};

/** Durations in seconds, as `motion` takes them. */
export const MOTION_DURATION = {
  fast: 0.12,
  base: 0.18,
  slow: 0.32,
  draw: 0.6,
} as const;

export const MOTION_SPRING = {
  snappy: { type: "spring" as const, stiffness: 600, damping: 34 },
  position: MOTION_SPRING_POSITION,
  page: { type: "spring" as const, stiffness: 380, damping: 36, mass: 0.8 },
  gentle: { type: "spring" as const, stiffness: 320, damping: 34 },
} as const;

/** Which way a change between two tabs travels: 1 forward, -1 back. */
export function tabDirection(
  order: readonly string[],
  from: string | undefined,
  to: string | undefined,
): 1 | -1 {
  const fromIndex = from === undefined ? -1 : order.indexOf(from);
  const toIndex = to === undefined ? -1 : order.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return 1;
  return toIndex < fromIndex ? -1 : 1;
}

export interface MotionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A CSS transform origin, in the box's own pixels, at the point of the box
 * nearest to the center of `target`: a surface grows out of the control that
 * opened it. The center when there is no target.
 */
export function originToward(
  target: MotionRect | null,
  box: MotionRect,
): string {
  if (
    !target ||
    (target.width <= 0 && target.height <= 0) ||
    box.width <= 0 ||
    box.height <= 0
  ) {
    return "50% 50%";
  }
  const clamp = (value: number, max: number) =>
    Math.round(Math.min(max, Math.max(0, value)));
  const x = clamp(target.x + target.width / 2 - box.x, box.width);
  const y = clamp(target.y + target.height / 2 - box.y, box.height);
  return `${x}px ${y}px`;
}
