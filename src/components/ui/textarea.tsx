"use client";

import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { useFieldVariant } from "@/components/ui/field-variant";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

const textareaVariants = cva(
  "flex min-h-[80px] w-full px-3 py-2 text-sm transition-[color,background-color,border-color,box-shadow] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default: `rounded-md border border-input bg-background ${FOCUS_RING} aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive`,
        soft: `rounded-lg bg-foreground/5 hover:bg-foreground/7 focus-visible:bg-foreground/7 ${FOCUS_RING} aria-invalid:bg-destructive/10 aria-invalid:ring-2 aria-invalid:ring-destructive/40 aria-invalid:focus-visible:ring-destructive`,
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> &
  VariantProps<typeof textareaVariants>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, variant, ...props }, ref) => {
    const inherited = useFieldVariant();
    return (
      <textarea
        className={cn(
          textareaVariants({ variant: variant ?? inherited }),
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
