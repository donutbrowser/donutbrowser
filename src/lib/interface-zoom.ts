/** Interface sizes the app offers, in percent. Matches the Rust list. */
export const INTERFACE_ZOOM_STEPS = [80, 90, 100, 110, 125, 150] as const;
export const DEFAULT_INTERFACE_ZOOM = 100;

/** The next size up (1), down (-1), or the default (0), from `current`. */
export function stepInterfaceZoom(
  current: number,
  direction: -1 | 0 | 1,
): number {
  if (direction === 0) return DEFAULT_INTERFACE_ZOOM;
  const steps = [...INTERFACE_ZOOM_STEPS];
  if (direction > 0) {
    return steps.find((step) => step > current) ?? steps[steps.length - 1];
  }
  return steps.findLast((step) => step < current) ?? steps[0];
}
