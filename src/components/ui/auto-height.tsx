"use client";

import { type HTMLMotionProps, motion, useAnimate } from "motion/react";
import * as React from "react";

import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { Slot, type WithAsChild } from "@/lib/slot";

/** How far, in pixels, changed content travels down into place. */
const SETTLE_TRAVEL = 4;

type AutoHeightProps = WithAsChild<
  {
    children: React.ReactNode;
    /** Values whose change means new content: it settles in with a slide. */
    deps?: React.DependencyList;
  } & HTMLMotionProps<"div">
>;

/**
 * A box that takes its content's height at once: height never animates.
 * When `deps` change, the content travels a few pixels down into place. It
 * is never hidden, so a paused webview still shows it. Keyboard and reduced
 * motion get it in place at once.
 */
function AutoHeight({
  children,
  deps = [],
  style,
  asChild = false,
  ...props
}: AutoHeightProps) {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const motionAllowed = useMotionAllowed();
  const previousDeps = React.useRef(deps);

  React.useLayoutEffect(() => {
    const previous = previousDeps.current;
    previousDeps.current = deps;
    const changed =
      previous.length !== deps.length ||
      deps.some((value, index) => !Object.is(value, previous[index]));
    if (!changed || !motionAllowed || !scope.current) return;
    animate(
      scope.current,
      { y: [-SETTLE_TRAVEL, 0] },
      { duration: MOTION_DURATION.base, ease: MOTION_EASE_OUT },
    );
  });

  const Comp = asChild ? Slot : motion.div;

  return (
    <Comp style={{ overflow: "auto", maxHeight: "100%", ...style }} {...props}>
      <div ref={scope} className="min-h-0">
        {children}
      </div>
    </Comp>
  );
}

export { AutoHeight, type AutoHeightProps };
