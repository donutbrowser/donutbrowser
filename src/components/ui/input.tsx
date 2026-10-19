"use client";

import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { useFieldVariant } from "@/components/ui/field-variant";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

const inputVariants = cva(
  "flex w-full min-w-0 text-base transition-[color,background-color,border-color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
  {
    variants: {
      variant: {
        default: `h-9 rounded-md border border-input bg-transparent px-3 py-1 shadow-xs ${FOCUS_RING} aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive dark:bg-input/30`,
        soft: `h-9 rounded-lg bg-foreground/5 px-3 py-1 hover:bg-foreground/7 focus-visible:bg-foreground/7 ${FOCUS_RING} aria-invalid:bg-destructive/10 aria-invalid:ring-2 aria-invalid:ring-destructive/40 aria-invalid:focus-visible:ring-destructive`,
        bare: "bg-transparent p-0",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Input({
  className,
  type,
  variant,
  ...props
}: React.ComponentProps<"input"> & VariantProps<typeof inputVariants>) {
  const inherited = useFieldVariant();
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        inputVariants({ variant: variant ?? inherited }),
        className,
      )}
      {...props}
    />
  );
}

export { Input };
