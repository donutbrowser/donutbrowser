"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";
import type { IconType } from "react-icons";
import { EmptyIcon } from "@/components/profile-table/empty-states";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";

/**
 * What a page shows before its first entry: what the thing is for, and the
 * one action that makes the first one.
 */
export function EntityEmptyState({
  entity,
  icon,
  title,
  description,
  children,
}: {
  entity: string;
  icon: IconType;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  const animate = useMotionAllowed();
  return (
    <motion.div
      data-slot="entity-empty-state"
      data-entity={entity}
      initial={animate ? { opacity: 0.5, transform: "translateY(6px)" } : false}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={{ duration: MOTION_DURATION.base, ease: MOTION_EASE_OUT }}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center"
    >
      <EmptyIcon icon={icon} animate={animate} />
      <div>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {description && (
          <p className="mt-1 max-w-sm text-xs text-pretty text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {children}
        </div>
      )}
    </motion.div>
  );
}
