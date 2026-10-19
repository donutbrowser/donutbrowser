"use client";

import { motion } from "motion/react";
import { Switch as SwitchPrimitive } from "radix-ui";
import * as React from "react";

import { FOCUS_RING } from "@/components/ui/focus-ring";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

const MotionThumb = motion.create(SwitchPrimitive.Thumb);

const THUMB_SPRING = {
  type: "spring" as const,
  stiffness: 700,
  damping: 32,
  mass: 0.5,
};

type AnimatedSwitchProps = React.ComponentProps<typeof SwitchPrimitive.Root>;

/**
 * Switch whose thumb actually slides between off and on. The Root flips
 * its flex alignment on `data-state=checked`, which moves the Thumb's
 * layout box; Motion's `layout` prop turns the move into a transform.
 * While the switch is pressed the thumb stretches toward its travel.
 * Keyboard and reduced motion get the new position at once.
 */
function AnimatedSwitch({
  className,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  onPointerCancel,
  ...props
}: AnimatedSwitchProps) {
  const motionAllowed = useMotionAllowed();
  const [pressed, setPressed] = React.useState(false);
  const release = () => setPressed(false);
  return (
    <SwitchPrimitive.Root
      data-slot="animated-switch"
      className={cn(
        "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center justify-start rounded-full border border-transparent px-[2px]",
        "bg-input data-[state=checked]:justify-end data-[state=checked]:bg-primary",
        "transition-colors duration-200 ease-out",
        FOCUS_RING,
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      onPointerDown={(event) => {
        if (event.button === 0) setPressed(true);
        onPointerDown?.(event);
      }}
      onPointerUp={(event) => {
        release();
        onPointerUp?.(event);
      }}
      onPointerLeave={(event) => {
        release();
        onPointerLeave?.(event);
      }}
      onPointerCancel={(event) => {
        release();
        onPointerCancel?.(event);
      }}
      {...props}
    >
      <MotionThumb
        data-slot="animated-switch-thumb"
        className={cn(
          "pointer-events-none block size-4 origin-left rounded-full shadow-sm ring-0 data-[state=checked]:origin-right",
          "bg-background data-[state=checked]:bg-primary-foreground",
        )}
        layout={motionAllowed ? "position" : false}
        initial={false}
        animate={{ scaleX: motionAllowed && pressed ? 1.15 : 1 }}
        transition={
          motionAllowed
            ? {
                layout: THUMB_SPRING,
                scaleX: {
                  duration: MOTION_DURATION.fast,
                  ease: MOTION_EASE_OUT,
                },
              }
            : { duration: 0 }
        }
      />
    </SwitchPrimitive.Root>
  );
}

export type { AnimatedSwitchProps };
export { AnimatedSwitch };
