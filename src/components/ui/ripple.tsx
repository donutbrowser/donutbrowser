"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { type HTMLMotionProps, motion, type Transition } from "motion/react";
import * as React from "react";

import { FOCUS_RING, PRESS } from "@/components/ui/focus-ring";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  `relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg text-sm font-medium whitespace-nowrap ${PRESS} ${FOCUS_RING} disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`,
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:shadow-sm",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:shadow-sm focus-visible:ring-destructive",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground dark:bg-input/30",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:shadow-sm",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        soft: "bg-foreground/6 text-foreground hover:bg-foreground/10",
      },
      size: {
        default: "h-10 px-4 py-2 has-[>svg]:px-3",
        sm: "h-9 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-11 px-8 has-[>svg]:px-6",
        icon: "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const rippleVariants = cva("pointer-events-none absolute size-5 rounded-full", {
  variants: {
    variant: {
      default: "bg-primary-foreground",
      destructive: "bg-destructive",
      outline: "bg-input",
      secondary: "bg-secondary",
      ghost: "bg-accent",
      soft: "bg-foreground/20",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

interface Ripple {
  id: number;
  x: number;
  y: number;
}

type RippleButtonProps = HTMLMotionProps<"button"> & {
  children: React.ReactNode;
  rippleClassName?: string;
  scale?: number;
  transition?: Transition;
} & VariantProps<typeof buttonVariants>;

function RippleButton({
  ref,
  children,
  onClick,
  className,
  rippleClassName,
  variant,
  size,
  scale = 10,
  transition = { duration: MOTION_DURATION.draw, ease: MOTION_EASE_OUT },
  ...props
}: RippleButtonProps) {
  const [ripples, setRipples] = React.useState<Ripple[]>([]);
  const motionAllowed = useMotionAllowed();
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  React.useImperativeHandle(ref, () => buttonRef.current as HTMLButtonElement);

  const createRipple = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const button = buttonRef.current;
      // A keyboard click has no point to ripple from (detail 0), and reduced
      // motion gets no ripple at all.
      if (!button || !motionAllowed || event.detail === 0) return;

      const rect = button.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const newRipple: Ripple = {
        id: Date.now(),
        x,
        y,
      };

      setRipples((prev) => [...prev, newRipple]);

      setTimeout(() => {
        setRipples((prev) => prev.filter((r) => r.id !== newRipple.id));
      }, MOTION_DURATION.draw * 1000);
    },
    [motionAllowed],
  );

  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      createRipple(event);
      if (onClick) {
        onClick(event);
      }
    },
    [createRipple, onClick],
  );

  return (
    <motion.button
      ref={buttonRef}
      data-slot="ripple-button"
      onClick={handleClick}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {children}
      {ripples.map((ripple) => (
        <motion.span
          key={ripple.id}
          initial={{ scale: 0, opacity: 0.5 }}
          animate={{ scale, opacity: 0 }}
          transition={transition}
          className={cn(
            rippleVariants({ variant, className: rippleClassName }),
          )}
          style={{
            top: ripple.y - 10,
            left: ripple.x - 10,
          }}
        />
      ))}
    </motion.button>
  );
}

export { RippleButton, type RippleButtonProps };
