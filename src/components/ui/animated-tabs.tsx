"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { motion } from "motion/react";
import * as React from "react";

import { FOCUS_RING } from "@/components/ui/focus-ring";
import { useControlledState } from "@/hooks/use-controlled-state";
import { useInputModality } from "@/hooks/use-input-modality";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import {
  MOTION_DURATION,
  MOTION_EASE_OUT,
  MOTION_SPRING,
  tabDirection,
} from "@/lib/motion";
import { cn } from "@/lib/utils";

/** How far, in pixels, a tab's content travels in from the side of its tab. */
const CONTENT_TRAVEL = 8;

interface TabChange {
  /** 0 until the first change: the first tab shown does not travel. */
  count: number;
  direction: 1 | -1;
}

interface AnimatedTabsContextValue {
  activeValue: string | undefined;
  hoveredValue: string | null;
  setHoveredValue: (value: string | null) => void;
  indicatorId: string;
  change: TabChange;
}

const AnimatedTabsContext =
  React.createContext<AnimatedTabsContextValue | null>(null);

function useAnimatedTabs() {
  const ctx = React.useContext(AnimatedTabsContext);
  if (!ctx) {
    throw new Error(
      "AnimatedTabsTrigger must be rendered inside <AnimatedTabs>",
    );
  }
  return ctx;
}

type AnimatedTabsProps = React.ComponentProps<typeof TabsPrimitive.Root>;

function AnimatedTabs({
  value: valueProp,
  defaultValue,
  onValueChange,
  children,
  ref,
  ...props
}: AnimatedTabsProps) {
  const [activeValue, setActiveValue] = useControlledState({
    value: valueProp,
    defaultValue,
    onChange: onValueChange,
  });
  const [hoveredValue, setHoveredValue] = React.useState<string | null>(null);
  const indicatorId = React.useId();
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const setRootRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const [change, setChange] = React.useState<TabChange>({
    count: 0,
    direction: 1,
  });
  // The content travels from the side of the tab it came from: the order is
  // the order of this list's triggers on screen.
  const selectValue = React.useCallback(
    (next: string) => {
      const order = Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>(
          '[data-slot="animated-tabs-trigger"]',
        ) ?? [],
        (trigger) => trigger.dataset.value ?? "",
      );
      setChange((previous) => ({
        count: previous.count + 1,
        direction: tabDirection(order, activeValue, next),
      }));
      setActiveValue(next);
    },
    [activeValue, setActiveValue],
  );

  return (
    <AnimatedTabsContext.Provider
      value={{
        activeValue,
        hoveredValue,
        setHoveredValue,
        indicatorId,
        change,
      }}
    >
      <TabsPrimitive.Root
        ref={setRootRef}
        data-slot="animated-tabs"
        value={activeValue}
        defaultValue={defaultValue}
        onValueChange={selectValue}
        {...props}
      >
        {children}
      </TabsPrimitive.Root>
    </AnimatedTabsContext.Provider>
  );
}

type AnimatedTabsListProps = React.ComponentProps<typeof TabsPrimitive.List>;

function AnimatedTabsList({
  className,
  onMouseLeave,
  ...props
}: AnimatedTabsListProps) {
  const { setHoveredValue } = useAnimatedTabs();
  return (
    <TabsPrimitive.List
      data-slot="animated-tabs-list"
      className={cn(
        "relative isolate inline-flex max-w-full scrollbar-none items-center gap-1 overflow-x-auto rounded-md p-0",
        className,
      )}
      onMouseLeave={(event) => {
        setHoveredValue(null);
        onMouseLeave?.(event);
      }}
      {...props}
    />
  );
}

type AnimatedTabsTriggerProps = React.ComponentProps<
  typeof TabsPrimitive.Trigger
>;

function AnimatedTabsTrigger({
  value,
  className,
  children,
  onMouseEnter,
  ...props
}: AnimatedTabsTriggerProps) {
  const { activeValue, hoveredValue, setHoveredValue, indicatorId } =
    useAnimatedTabs();
  const inputModality = useInputModality();
  const animateIndicator = useMotionAllowed();
  // The visible pill follows hover when present, otherwise sits on the
  // active tab. Framer's `layoutId` handles the slide animation between
  // mounted instances; only the trigger whose `value` matches `shownValue`
  // renders the indicator, so the transition is a single-element move.
  const shownValue =
    inputModality === "keyboard" ? activeValue : (hoveredValue ?? activeValue);
  const showIndicator = shownValue === value;
  const isActive = activeValue === value;

  return (
    <TabsPrimitive.Trigger
      data-slot="animated-tabs-trigger"
      data-value={value}
      value={value}
      onMouseEnter={(event) => {
        if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
          setHoveredValue(value);
        }
        onMouseEnter?.(event);
      }}
      className={cn(
        "relative inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150",
        "text-muted-foreground hover:text-foreground",
        isActive && !showIndicator && "text-foreground",
        showIndicator && "text-accent-foreground hover:text-accent-foreground",
        FOCUS_RING,
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {showIndicator && (
        <motion.span
          layoutId={
            animateIndicator
              ? `animated-tabs-indicator-${indicatorId}`
              : undefined
          }
          initial={false}
          data-slot="animated-tabs-indicator"
          className="pointer-events-none absolute inset-0 -z-10 rounded-md bg-accent"
          transition={
            animateIndicator ? MOTION_SPRING.position : { duration: 0 }
          }
        />
      )}
      {children}
    </TabsPrimitive.Trigger>
  );
}

type AnimatedTabsContentProps = React.ComponentProps<
  typeof TabsPrimitive.Content
>;

/**
 * A tab's panel. When the tab changes by pointer it travels a few pixels in
 * from the side of the tab it came from; it is never hidden behind the
 * motion, so a paused webview still shows it in place. Keyboard and reduced
 * motion get it in place at once.
 */
function AnimatedTabsContent({
  value,
  forceMount,
  children,
  ...props
}: AnimatedTabsContentProps) {
  const { activeValue, change } = useAnimatedTabs();
  const travel = useMotionAllowed() && change.count > 0;
  const active = activeValue === value;
  const from = change.direction * CONTENT_TRAVEL;
  return (
    <TabsPrimitive.Content
      asChild
      value={value}
      forceMount={forceMount}
      {...props}
    >
      <motion.div
        initial={travel ? { x: from } : false}
        // A panel kept mounted while hidden replays the travel each time its
        // tab comes back.
        animate={{ x: travel && active ? [from, 0] : 0 }}
        transition={{
          duration: travel ? MOTION_DURATION.base : 0,
          ease: MOTION_EASE_OUT,
        }}
      >
        {children}
      </motion.div>
    </TabsPrimitive.Content>
  );
}

export type {
  AnimatedTabsContentProps,
  AnimatedTabsListProps,
  AnimatedTabsProps,
  AnimatedTabsTriggerProps,
};
export {
  AnimatedTabs,
  AnimatedTabsContent,
  AnimatedTabsList,
  AnimatedTabsTrigger,
};
