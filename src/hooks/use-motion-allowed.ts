"use client";

import { useReducedMotion } from "motion/react";
import { useInputModality } from "@/hooks/use-input-modality";

/**
 * Whether decorative motion may run: not under reduced motion, and only for
 * pointer users. A keyboard user gets the end state at once.
 */
export function useMotionAllowed(): boolean {
  const reduceMotion = useReducedMotion();
  const modality = useInputModality();
  return !reduceMotion && modality === "pointer";
}
