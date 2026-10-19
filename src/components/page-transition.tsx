"use client";

import {
  AnimatePresence,
  motion,
  PresenceContext,
  type TargetAndTransition,
  type Transition,
  usePresence,
} from "motion/react";
import {
  type Key,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_DURATION, MOTION_EASE_IN, MOTION_SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The longest an outgoing layer stays mounted. Its fade is shorter; this
 * holds when the animation clock stops (an occluded or throttled webview),
 * so a frozen fade never leaves the old content on screen.
 */
const EXIT_FALLBACK_MS = 200;

const EXIT_TRANSITION: Transition = {
  duration: MOTION_DURATION.fast,
  ease: MOTION_EASE_IN,
};

type LayerTag = "div" | "span";

interface LayerProps {
  ref?: Ref<HTMLDivElement & HTMLSpanElement>;
  as: LayerTag;
  /** Where the entering layer starts. Entering content stays readable. */
  from: TargetAndTransition;
  transition: Transition;
  animate: boolean;
  className?: string;
  children: ReactNode;
}

function Layer({
  ref,
  as,
  from,
  transition,
  animate,
  className,
  children,
}: LayerProps) {
  const [isPresent, safeToRemove] = usePresence();
  // AnimatePresence initial={false}: what is there at mount does not enter.
  const mountedWithParent = useContext(PresenceContext)?.initial === false;
  const removed = useRef(false);
  const remove = useRef(safeToRemove);
  remove.current = safeToRemove;

  const finish = useCallback(() => {
    if (removed.current) return;
    removed.current = true;
    remove.current?.();
  }, []);

  useEffect(() => {
    if (isPresent) {
      removed.current = false;
      return;
    }
    if (!animate) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, EXIT_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [isPresent, animate, finish]);

  const MotionTag = as === "span" ? motion.span : motion.div;
  return (
    // The layer alone answers to AnimatePresence: motion components inside
    // the page never hold an exit open.
    <PresenceContext.Provider value={null}>
      <MotionTag
        ref={ref}
        className={cn(className, !isPresent && "pointer-events-none")}
        style={isPresent ? { position: "relative", zIndex: 1 } : undefined}
        inert={!isPresent || undefined}
        aria-hidden={!isPresent || undefined}
        initial={animate && !mountedWithParent ? from : false}
        animate={
          isPresent ? { opacity: 1, x: 0, y: 0, scale: 1 } : { opacity: 0 }
        }
        transition={isPresent ? transition : EXIT_TRANSITION}
        onAnimationComplete={() => {
          if (!isPresent) finish();
        }}
      >
        {children}
      </MotionTag>
    </PresenceContext.Provider>
  );
}

interface SwapProps {
  /** A new key swaps the content: the new one enters, the old one fades. */
  swapKey: Key;
  from: TargetAndTransition;
  transition: Transition;
  as?: LayerTag;
  className?: string;
  children: ReactNode;
}

/**
 * Swaps content with an entrance and a short fade-out that never blocks:
 * the new content is in the DOM at once (mode="popLayout"), and the old one
 * leaves within 200 ms whether or not its fade ran.
 */
export function Swap({
  swapKey,
  from,
  transition,
  as = "div",
  className,
  children,
}: SwapProps) {
  const animate = useMotionAllowed();
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <Layer
        key={swapKey}
        as={as}
        from={from}
        transition={transition}
        animate={animate}
        className={className}
      >
        {children}
      </Layer>
    </AnimatePresence>
  );
}

interface PageTransitionProps {
  pageKey: Key;
  /** +1 when the new page is further down the rail, -1 when it is above. */
  direction: 1 | -1;
  className?: string;
  children: ReactNode;
}

/**
 * Moves between app pages: the new page slides 16px in from the side it
 * lies on in the rail while the old one fades out. The parent must be
 * positioned (`relative`) so the outgoing page can pop out of the flow.
 */
export function PageTransition({
  pageKey,
  direction,
  className,
  children,
}: PageTransitionProps) {
  return (
    <Swap
      swapKey={pageKey}
      from={{ x: direction * 16, scale: 0.995, opacity: 0.6 }}
      transition={MOTION_SPRING.page}
      className={className}
    >
      {children}
    </Swap>
  );
}
