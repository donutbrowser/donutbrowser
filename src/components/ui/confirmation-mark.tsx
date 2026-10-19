"use client";

import { motion } from "motion/react";
import { LuCheck } from "react-icons/lu";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_EASE_OUT } from "@/lib/motion";

export function ConfirmationMark() {
  const motionAllowed = useMotionAllowed();
  return (
    <motion.span
      aria-hidden="true"
      initial={motionAllowed ? { scale: 0.9 } : false}
      animate={{ scale: 1 }}
      transition={{ duration: 0.14, ease: MOTION_EASE_OUT }}
      className="inline-flex shrink-0 text-success-text"
    >
      <LuCheck className="size-3.5" />
    </motion.span>
  );
}
