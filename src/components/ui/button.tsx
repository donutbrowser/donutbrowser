import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { FOCUS_RING, PRESS } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  `inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap ${FOCUS_RING} disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`,
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:shadow-sm",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:shadow-sm focus-visible:ring-destructive",
        outline:
          "border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:shadow-sm",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        // Tinted from the theme's own foreground, so the fill stays quiet in
        // themes whose accent or secondary color is loud.
        soft: "bg-foreground/6 text-foreground hover:bg-foreground/10 aria-expanded:bg-foreground/10",
        subtle:
          "text-muted-foreground hover:bg-foreground/6 hover:text-foreground aria-expanded:bg-foreground/6 aria-expanded:text-foreground",
        link: "text-primary-text underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    compoundVariants: [
      {
        variant: [
          "default",
          "destructive",
          "outline",
          "secondary",
          "ghost",
          "soft",
          "subtle",
        ],
        className: PRESS,
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
