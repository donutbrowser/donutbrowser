"use client";

import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";

import { isMacOS } from "@/lib/platform";
import type { KeyName, KeyToken } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/** A key going down settles at once; coming up it rebounds a little. */
const KEY_SPRING = {
  type: "spring" as const,
  stiffness: 900,
  damping: 28,
  mass: 0.4,
};

const SPOKEN: Record<KeyName, string> = {
  mod: "common.keys.control",
  shift: "common.keys.shift",
  alt: "common.keys.alt",
  enter: "common.keys.enter",
  escape: "common.keys.escape",
  backspace: "common.keys.backspace",
  up: "common.keys.arrowUp",
  down: "common.keys.arrowDown",
};

function spokenKey(name: KeyName) {
  if (isMacOS() && name === "mod") return "common.keys.command";
  if (isMacOS() && name === "alt") return "common.keys.option";
  return SPOKEN[name];
}

interface KbdProps {
  token: KeyToken;
  size?: "sm" | "md";
  /** Drawn pushed into its ledge, as a key that is held down. */
  pressed?: boolean;
  className?: string;
}

/** One keycap: a key with a ledge under it that it sinks into when pressed. */
export function Kbd({
  token,
  size = "sm",
  pressed = false,
  className,
}: KbdProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  return (
    <motion.kbd
      data-slot="kbd"
      data-pressed={pressed ? "true" : undefined}
      initial={false}
      animate={{ y: pressed ? 1 : 0 }}
      transition={reduceMotion ? { duration: 0 } : KEY_SPRING}
      className={cn(
        "inline-flex items-center justify-center rounded-[5px] border border-border bg-background font-sans font-medium text-muted-foreground shadow-[0_1px_0_0_var(--color-border)] transition-[background-color,color,box-shadow] duration-150 select-none",
        size === "sm"
          ? "h-5 min-w-5 px-1 text-[11px]"
          : "h-6 min-w-6 px-1.5 text-[11px]",
        pressed && "bg-foreground/10 text-foreground shadow-none",
        className,
      )}
    >
      {token.name ? (
        <>
          <span aria-hidden="true">{token.glyph}</span>
          <span className="sr-only">{t(spokenKey(token.name))}</span>
        </>
      ) : (
        token.glyph
      )}
    </motion.kbd>
  );
}

interface KbdGroupProps {
  keys: KeyToken[];
  size?: "sm" | "md";
  /** Which keys are drawn held down, by index. */
  pressed?: (index: number) => boolean;
  className?: string;
}

export function KbdGroup({ keys, size, pressed, className }: KbdGroupProps) {
  return (
    <span
      data-slot="kbd-group"
      className={cn(
        "inline-flex shrink-0 items-center",
        size === "md" ? "gap-1" : "gap-0.5",
        className,
      )}
    >
      {keys.map((token, index) => (
        <Kbd
          key={`${index}-${token.glyph}`}
          token={token}
          size={size}
          pressed={pressed?.(index) ?? false}
        />
      ))}
    </span>
  );
}
