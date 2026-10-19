/**
 * The keyboard focus ring of every control: 2px of the full ring color, 2px
 * away from the control. Lighter rings fall under 3:1 contrast in some themes.
 */
export const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** One press feel for every button: a short, transform-only squeeze. */
export const PRESS =
  "transition-transform duration-[120ms] ease-[var(--ease-out)] active:scale-[0.97] motion-reduce:active:scale-100";
