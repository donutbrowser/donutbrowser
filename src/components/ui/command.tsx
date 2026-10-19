"use client";

import { Command as CommandPrimitive } from "cmdk";
import { motion, useReducedMotion } from "motion/react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { LuSearch } from "react-icons/lu";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MOTION_DURATION, MOTION_SPRING_POSITION } from "@/lib/motion";
import { cn } from "@/lib/utils";

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex size-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title,
  description,
  children,
  filter,
  shouldFilter,
  value,
  onValueChange,
  loop,
  onKeyDown,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  filter?: React.ComponentProps<typeof CommandPrimitive>["filter"];
  shouldFilter?: React.ComponentProps<typeof CommandPrimitive>["shouldFilter"];
  /** The selected item's value. */
  value?: string;
  onValueChange?: (value: string) => void;
  loop?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  /** Call `preventDefault()` to keep the dialog open. */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t("common.commandPalette.title");
  const resolvedDescription =
    description ?? t("common.commandPalette.description");
  return (
    <Dialog {...props}>
      <DialogContent
        hideClose
        onEscapeKeyDown={onEscapeKeyDown}
        className="gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{resolvedTitle}</DialogTitle>
          <DialogDescription>{resolvedDescription}</DialogDescription>
        </DialogHeader>
        <Command
          filter={filter}
          shouldFilter={shouldFilter}
          value={value}
          onValueChange={onValueChange}
          loop={loop}
          onKeyDown={onKeyDown}
          className="**:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-item]_svg]:size-4 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground **:[[cmdk-group]]:px-2 **:[[cmdk-input]]:h-12 **:[[cmdk-item]]:px-2.5 **:[[cmdk-item]]:py-2.5"
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  leading,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  /** Drawn between the search icon and the field, e.g. a breadcrumb. */
  leading?: React.ReactNode;
}) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-9 items-center gap-2 border-b px-3"
    >
      <LuSearch className="size-4 shrink-0 opacity-50" />
      {leading}
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "max-h-[min(50vh,500px)] scroll-py-1 overflow-x-hidden overflow-y-auto [&>[cmdk-list-sizer]]:relative",
        className,
      )}
      {...props}
    />
  );
}

interface GlideBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `element`'s layout offset inside `container`, ignoring transforms. */
function offsetWithin(element: HTMLElement, container: HTMLElement) {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = element;
  while (node && node !== container) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return node === container ? { x, y } : null;
}

/**
 * One highlight that glides to whichever item is selected, by key or by
 * pointer. Place it inside `CommandList`, in a positioned parent that holds
 * the items, and make the selected items themselves transparent.
 */
function CommandGlide({ className }: { className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [box, setBox] = React.useState<GlideBox | null>(null);
  const shown = React.useRef(false);

  React.useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      const item = parent.querySelector<HTMLElement>(
        '[cmdk-item][data-selected="true"]',
      );
      const offset = item ? offsetWithin(item, parent) : null;
      if (!item || !offset) {
        setBox(null);
        return;
      }
      const next = {
        ...offset,
        width: item.offsetWidth,
        height: item.offsetHeight,
      };
      setBox((prev) =>
        prev &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next,
      );
    };
    measure();
    const mutations = new MutationObserver(measure);
    mutations.observe(parent, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-selected", "hidden"],
    });
    const resizes = new ResizeObserver(measure);
    resizes.observe(parent);
    return () => {
      mutations.disconnect();
      resizes.disconnect();
    };
  }, []);

  // The first placement jumps; only a move between items glides.
  const instant = reduceMotion || !shown.current;
  // A fading highlight keeps the size it had.
  const size = React.useRef<{ width: number; height: number } | null>(null);
  if (box) size.current = { width: box.width, height: box.height };
  React.useEffect(() => {
    shown.current = box !== null;
  }, [box]);

  return (
    <motion.div
      ref={ref}
      aria-hidden="true"
      data-slot="command-glide"
      className={cn(
        "pointer-events-none absolute top-0 left-0 rounded-md bg-primary/10",
        className,
      )}
      // Only the position glides; the size follows at once, so nothing but
      // transform and opacity animates.
      style={size.current ?? undefined}
      initial={false}
      animate={box ? { x: box.x, y: box.y, opacity: 1 } : { opacity: 0 }}
      transition={
        instant
          ? { duration: 0 }
          : {
              ...MOTION_SPRING_POSITION,
              opacity: { duration: MOTION_DURATION.fast },
            }
      }
    >
      <span className="absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
    </motion.div>
  );
}

function CommandEmpty({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-sm"
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-x-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[selected=true]:[&_svg:not([class*='text-'])]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGlide,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};
