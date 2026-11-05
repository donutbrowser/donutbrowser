"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { type ClipId, RestingClip } from "@/components/feature-clip";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";

/**
 * What a page shows before its first entry: what the thing is for, and the
 * one action that makes the first one. The recording of the feature in use
 * is decorative: it plays a few loops, then rests on its still.
 */
export function EntityEmptyState({
  entity,
  clip,
  title,
  description,
  children,
}: {
  entity: string;
  clip: ClipId;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  const animate = useMotionAllowed();
  return (
    <motion.div
      data-slot="entity-empty-state"
      data-entity={entity}
      initial={animate ? { opacity: 0.5, transform: "translateY(8px)" } : false}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={{ duration: MOTION_DURATION.slow, ease: MOTION_EASE_OUT }}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center"
    >
      <RestingClip
        id={clip}
        className="aspect-[2/1] w-80 max-w-full shrink-0 rounded-xl"
      />
      <div className="flex max-w-sm flex-col gap-1.5">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        <p className="text-xs leading-relaxed text-pretty text-muted-foreground">
          {description}
        </p>
      </div>
      {children && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {children}
        </div>
      )}
    </motion.div>
  );
}
