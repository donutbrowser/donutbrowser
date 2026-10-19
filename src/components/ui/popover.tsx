"use client";

import * as PopoverPrimitive from "@radix-ui/react-popover";
import type * as React from "react";

import { usePopupMotion } from "@/components/ui/popup-motion";
import { cn } from "@/lib/utils";

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  collisionPadding = 8,
  ref,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const popupMotion = usePopupMotion(ref);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "popup-motion z-50000 max-h-(--radix-popover-content-available-height) origin-(--radix-popover-content-transform-origin) overflow-y-auto rounded-md border bg-popover p-4 text-popover-foreground shadow-sm outline-hidden",
          className,
        )}
        {...props}
        {...popupMotion}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
