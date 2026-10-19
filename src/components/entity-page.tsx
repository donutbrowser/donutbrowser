"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { AnimatedSwitch } from "@/components/ui/animated-switch";
import { Button, type ButtonProps } from "@/components/ui/button";
import { RippleButton, type RippleButtonProps } from "@/components/ui/ripple";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Movement runs only for pointer users who allow motion. */
export const useEntityMotion = useMotionAllowed;

const RowNameContext = createContext<string | undefined>(undefined);

/** Names the row its actions belong to, so each action's label can say which. */
export function RowNameProvider({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  return (
    <RowNameContext.Provider value={name}>{children}</RowNameContext.Provider>
  );
}

const TICK = {
  enter: (direction: number) => ({
    opacity: 0.5,
    transform: `translateY(${direction * 70}%)`,
  }),
  center: { opacity: 1, transform: "translateY(0%)" },
  exit: (direction: number) => ({
    opacity: 0,
    transform: `translateY(${direction * -70}%)`,
  }),
};

/** A count that rolls to its new value: up when it grows, down when it shrinks. */
export function TickingCount({
  value,
  className,
  slot,
}: {
  value: number;
  className?: string;
  slot?: string;
}) {
  const animate = useEntityMotion();
  const previous = useRef(value);
  const direction = value >= previous.current ? 1 : -1;
  useEffect(() => {
    previous.current = value;
  }, [value]);
  return (
    <span
      data-slot={slot}
      className={cn(
        "relative inline-flex overflow-hidden tabular-nums",
        className,
      )}
    >
      <AnimatePresence initial={false} mode="popLayout" custom={direction}>
        <motion.span
          key={value}
          custom={direction}
          variants={TICK}
          initial={animate ? "enter" : false}
          animate="center"
          exit="exit"
          transition={{
            duration: animate ? MOTION_DURATION.base : 0,
            ease: MOTION_EASE_OUT,
          }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * What kind of thing a row is: a protocol, a tunnel type. Neutral on purpose,
 * since a type is a fact, not a state that needs attention.
 */
export function KindBadge({
  children,
  icon,
  className,
  ...props
}: React.ComponentProps<"span"> & { icon?: ReactNode }) {
  return (
    <span
      {...props}
      data-slot="kind-badge"
      className={cn(
        "inline-flex h-5 max-w-full items-center gap-1 rounded-md bg-foreground/6 px-1.5 font-mono text-[10px] leading-none font-medium tracking-wide text-muted-foreground uppercase [&_svg]:size-2.5 [&_svg]:shrink-0",
        className,
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

export type SyncStatus =
  | "disabled"
  | "syncing"
  | "synced"
  | "error"
  | "waiting";

const SYNC_DOT: Record<SyncStatus, string> = {
  synced: "bg-success",
  syncing: "bg-primary motion-safe:animate-pulse",
  waiting: "bg-primary/40",
  error: "bg-destructive",
  disabled: "bg-foreground/15",
};

/** The sync switch of one row, with a light for where its sync stands. */
export function SyncCell({
  name,
  enabled,
  lastSync,
  status: liveStatus,
  error,
  busy = false,
  lockedReason,
  onToggle,
}: {
  name: string;
  enabled: boolean;
  lastSync?: number;
  status?: SyncStatus;
  error?: string;
  busy?: boolean;
  /** Why the switch cannot be flipped; the switch is disabled when set. */
  lockedReason?: string;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const status: SyncStatus = !enabled
    ? "disabled"
    : liveStatus && liveStatus !== "disabled"
      ? liveStatus
      : "synced";
  const statusText =
    status === "syncing"
      ? t("syncTooltips.syncing")
      : status === "waiting"
        ? t("syncTooltips.waiting")
        : status === "error"
          ? error
            ? t("syncTooltips.errorWith", { error })
            : t("syncTooltips.error")
          : status === "synced"
            ? lastSync
              ? t("syncTooltips.syncedAt", {
                  time: new Date(lastSync * 1000).toLocaleString(),
                })
              : t("syncTooltips.synced")
            : t("syncTooltips.notSynced");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-slot="sync-cell"
          data-sync={status}
          className="inline-flex items-center gap-2"
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-2 shrink-0 rounded-full transition-colors duration-200",
              SYNC_DOT[status],
            )}
          />
          <AnimatedSwitch
            aria-label={`${t("proxies.management.syncCol")}: ${name}`}
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={busy || Boolean(lockedReason)}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{statusText}</p>
        <p className="text-primary-foreground/75">
          {lockedReason ??
            t(enabled ? "syncTooltips.disable" : "syncTooltips.enable")}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/** The trailing cell of a row; its actions wait for hover or focus. */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="row-actions"
      className="flex items-center justify-end gap-0.5"
    >
      {children}
    </div>
  );
}

export function RowAction({
  label,
  name,
  tooltip,
  icon,
  tone = "default",
  disabled,
  className,
  ...props
}: Omit<ButtonProps, "children"> & {
  label: string;
  /** The row's entity; defaults to the name its table row provides. */
  name?: string;
  tooltip?: ReactNode;
  icon: ReactNode;
  tone?: "default" | "destructive";
}) {
  const { t } = useTranslation();
  const rowName = useContext(RowNameContext);
  const subject = name ?? rowName;
  const button = (
    <Button
      type="button"
      variant="subtle"
      size="icon"
      aria-label={
        subject
          ? t("tables.rowAction", { action: label, name: subject })
          : label
      }
      disabled={disabled}
      className={cn(
        "row-reveal size-7 rounded-md [&_svg]:size-3.5",
        tone === "destructive" &&
          "hover:bg-destructive/10 hover:text-destructive-text",
        className,
      )}
      {...props}
    >
      {icon}
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? <span className="inline-flex">{button}</span> : button}
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltip ?? label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/** A page-level action; its label folds into the tooltip on narrow pages. */
export function PageAction({
  icon,
  label,
  tooltip,
  primary = false,
  className,
  ...props
}: Omit<RippleButtonProps, "children"> & {
  icon: ReactNode;
  label: string;
  tooltip?: string;
  primary?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <RippleButton
          size="sm"
          variant={primary ? "default" : "soft"}
          aria-label={label}
          className={cn("gap-2", className)}
          {...props}
        >
          {icon}
          <span className="hidden @2xl:inline">{label}</span>
        </RippleButton>
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltip ?? label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export type CheckState = "idle" | "checking" | "ok" | "failed";

/** A spinner that stands still under reduced motion; the text says it is working. */
export function CheckSpinner() {
  return (
    <span
      aria-hidden="true"
      className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none"
    />
  );
}

/**
 * The last check of a connection, as a pill that opens its details. Only a
 * check run while the pill is on screen rolls in; a stored result that
 * arrives after mount just appears, so a long list does not animate at once.
 */
export function CheckPill({
  state,
  icon,
  resultKey,
  compact = false,
  children,
  className,
  "aria-describedby": describedBy,
  ...props
}: React.ComponentProps<"button"> & {
  state: CheckState;
  icon: ReactNode;
  /** Changes when a new result arrives, so the same state still rolls in. */
  resultKey?: string | number;
  /** Shows the icon alone; the text stays for screen readers. */
  compact?: boolean;
}) {
  const textId = useId();
  const motionAllowed = useEntityMotion();
  const previous = useRef(state);
  const roll =
    motionAllowed && (previous.current === "checking" || state === "checking");
  useEffect(() => {
    previous.current = state;
  }, [state]);
  return (
    <button
      type="button"
      {...props}
      aria-describedby={
        [describedBy, compact ? textId : null].filter(Boolean).join(" ") ||
        undefined
      }
      data-slot="check-pill"
      data-check-state={state}
      className={cn(
        "relative inline-flex h-6 max-w-full cursor-pointer items-center overflow-hidden rounded-full text-xs whitespace-nowrap outline-none transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100 [&_svg]:size-3 [&_svg]:shrink-0",
        compact ? "w-6 justify-center" : "px-2",
        state === "failed"
          ? "bg-destructive/10 text-destructive-text hover:bg-destructive/15"
          : state === "ok"
            ? "bg-foreground/5 text-foreground hover:bg-foreground/10"
            : "bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        className,
      )}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={`${state}:${resultKey ?? ""}`}
          className="inline-flex min-w-0 items-center gap-1.5"
          initial={roll ? { opacity: 0.5, transform: "scale(0.9)" } : false}
          animate={{ opacity: 1, transform: "scale(1)" }}
          exit={
            roll
              ? { opacity: 0, transform: "scale(0.9)" }
              : { opacity: 0, transition: { duration: 0 } }
          }
          transition={{ duration: MOTION_DURATION.base, ease: MOTION_EASE_OUT }}
        >
          {icon}
          {!compact && <span className="truncate">{children}</span>}
        </motion.span>
      </AnimatePresence>
      {compact && (
        <span id={textId} className="sr-only">
          {children}
        </span>
      )}
    </button>
  );
}
