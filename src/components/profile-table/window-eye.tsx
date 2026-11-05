"use client";

import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

/** Spreads the rows' blinks over the cycle, so open windows never blink together. */
function blinkOffset(seed: string) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 5000;
}

/**
 * A running profile's eye beside its checkbox, in place of the browser icon.
 * It opens when the window does, blinks now and then, and a click brings the
 * window to the front.
 */
export function WindowEye({
  label,
  seed,
  onShow,
}: {
  label: string;
  seed: string;
  onShow: () => void;
}) {
  return (
    <button
      type="button"
      data-slot="row-window-eye"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onShow();
      }}
      className={cn(
        "grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-foreground/70 transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground",
        FOCUS_RING,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="eye-open size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <g
          className="eye-blink"
          style={{ animationDelay: `-${blinkOffset(seed)}ms` }}
        >
          <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
          <circle
            className="eye-look"
            cx="12"
            cy="12"
            r="3"
            style={{ animationDelay: `-${blinkOffset(seed) * 2}ms` }}
          />
        </g>
      </svg>
    </button>
  );
}
