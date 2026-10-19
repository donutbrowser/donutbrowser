import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  `inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors ${FOCUS_RING} aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive [&>svg]:pointer-events-none [&>svg]:size-3`,
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground [a&]:hover:shadow-sm",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [a&]:hover:shadow-sm",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground focus-visible:ring-destructive [a&]:hover:shadow-sm",
        outline:
          "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        soft: "border-transparent bg-foreground/8 text-foreground [a&]:hover:bg-foreground/12",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
