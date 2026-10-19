"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { type HTMLMotionProps, motion } from "motion/react";
import * as React from "react";

import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

type TabsProps = React.ComponentProps<typeof TabsPrimitive.Root>;

function Tabs(props: TabsProps) {
  return <TabsPrimitive.Root data-slot="tabs" {...props} />;
}

type TabsListProps = React.ComponentProps<typeof TabsPrimitive.List>;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  TabsListProps
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    data-slot="tabs-list"
    className={cn(
      "inline-flex h-10 max-w-full scrollbar-none items-center justify-center overflow-x-auto rounded-md bg-muted p-1 text-muted-foreground",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

type TabsTriggerProps = React.ComponentProps<typeof TabsPrimitive.Trigger>;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  TabsTriggerProps
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    data-slot="tabs-trigger"
    className={cn(
      "inline-flex cursor-pointer items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-[color,background-color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
      FOCUS_RING,
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

type TabsContentProps = React.ComponentProps<typeof TabsPrimitive.Content> &
  HTMLMotionProps<"div">;

function TabsContent({
  value,
  forceMount,
  className,
  ...props
}: TabsContentProps) {
  return (
    <TabsPrimitive.Content asChild forceMount={forceMount} value={value}>
      <motion.div
        data-slot="tabs-content"
        initial={false}
        className={cn("mt-2", FOCUS_RING, className)}
        {...props}
      />
    </TabsPrimitive.Content>
  );
}

export {
  Tabs,
  TabsContent,
  type TabsContentProps,
  TabsList,
  type TabsListProps,
  type TabsProps,
  TabsTrigger,
  type TabsTriggerProps,
};
