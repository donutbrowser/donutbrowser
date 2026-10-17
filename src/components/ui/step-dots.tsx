"use client";

import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";
import { useInputModality } from "@/hooks/use-input-modality";
import { MOTION_SPRING_POSITION } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Where a person is in a short flow: one dot per step, the current one drawn
 * long, the finished ones darker. The current mark glides to the next dot
 * when the step changes by pointer, and jumps for keyboard and reduced motion.
 */
export function StepDots({
  count,
  current,
  label,
  className,
}: {
  count: number;
  /** Zero-based. */
  current: number;
  label: string;
  className?: string;
}) {
  const id = useId();
  const reduceMotion = useReducedMotion();
  const modality = useInputModality();
  const glide = !reduceMotion && modality === "pointer";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={count}
      aria-valuenow={current + 1}
      data-slot="step-dots"
      className={cn("flex items-center gap-1.5", className)}
    >
      {Array.from({ length: count }, (_, index) => {
        const active = index === current;
        return (
          <span
            key={index}
            data-active={active}
            className={cn(
              "relative h-1.5 rounded-full transition-[background-color] duration-300",
              active ? "w-4" : "w-1.5",
              index < current ? "bg-foreground/35" : "bg-foreground/12",
            )}
          >
            {active && (
              <motion.span
                aria-hidden="true"
                layoutId={glide ? `${id}-current` : undefined}
                initial={false}
                transition={glide ? MOTION_SPRING_POSITION : { duration: 0 }}
                className="absolute inset-0 rounded-full bg-primary"
              />
            )}
          </span>
        );
      })}
    </div>
  );
}
