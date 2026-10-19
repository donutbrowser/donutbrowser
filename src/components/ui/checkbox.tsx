"use client";

import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import type * as React from "react";
import { LuCheck, LuMinus } from "react-icons/lu";

import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 cursor-pointer rounded-[4px] border border-input shadow-xs disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:bg-input/30 dark:data-[state=checked]:bg-primary",
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="group/indicator flex items-center justify-center text-current transition-none"
      >
        <LuCheck className="size-3.5 group-data-[state=indeterminate]/indicator:hidden" />
        <LuMinus className="hidden size-3.5 group-data-[state=indeterminate]/indicator:block" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
