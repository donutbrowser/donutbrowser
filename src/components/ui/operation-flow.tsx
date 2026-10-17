"use client";

import { motion, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { useInputModality } from "@/hooks/use-input-modality";
import { MOTION_EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface OperationStep {
  id: string;
  label: string;
  detail: ReactNode;
}

type NodeState = "done" | "active" | "failed" | "pending";

/**
 * A measured relationship or operation as a row of stations.
 *
 * Every station before the current one is settled and wears a check; the
 * current one is a ring, or a cross when the operation failed there; the
 * ones after it wait as small dots. The wire between stations fills as they
 * settle, and while the operation is busy a pulse travels the wire into the
 * station being worked on. Reaching the last station with nothing failed
 * settles the whole row.
 */
export function OperationFlow({
  steps,
  active,
  failed = false,
  busy = false,
  compact = false,
  label,
}: {
  steps: OperationStep[];
  /** The station the operation is at. */
  active: number;
  /** The operation stopped at `active`. */
  failed?: boolean;
  /** The operation is still working towards `active`. */
  busy?: boolean;
  /**
   * One inline line: each label beside its station, short wires between
   * them, and the details read only by screen readers.
   */
  compact?: boolean;
  label: string;
}) {
  const reduced = useReducedMotion();
  const modality = useInputModality();
  const animate = !reduced && modality !== "keyboard";
  const last = steps.length - 1;
  const current = Math.max(0, Math.min(last, active));
  if (steps.length < 2) return null;

  const complete = !busy && !failed && current === last;
  const stateOf = (index: number): NodeState => {
    if (complete || index < current) return "done";
    if (index === current) return failed ? "failed" : "active";
    return "pending";
  };
  // The wire into a station fills once that station is settled.
  const filledInto = (index: number) =>
    complete || index < current || (index === current && !busy && !failed);
  const pulsingInto = (index: number) => busy && index === current;
  const at = (index: number) => `${(index / last) * 100}%`;
  const flowState = failed
    ? "failed"
    : busy
      ? "busy"
      : complete
        ? "done"
        : "active";

  if (compact) {
    return (
      <ol
        data-slot="operation-flow"
        data-variant="compact"
        data-state={flowState}
        aria-label={label}
        className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1"
      >
        {steps.map((step, index) => {
          const state = stateOf(index);
          return (
            <li
              key={step.id}
              aria-current={index === current ? "step" : undefined}
              data-node-state={state}
              className="flex min-w-0 items-center gap-1.5"
            >
              {index > 0 && (
                <FlowWire
                  filled={filledInto(index)}
                  pulsing={pulsingInto(index)}
                  animate={animate}
                  className="relative w-4 shrink-0"
                />
              )}
              <FlowNode
                state={state}
                current={index === current}
                animate={animate}
                className="shrink-0"
              />
              <span className={cn("truncate", labelClass(state))}>
                {step.label}
              </span>
              <span className="sr-only">{step.detail}</span>
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <div
      data-slot="operation-flow"
      data-state={flowState}
      role="group"
      aria-label={label}
      className="min-w-0 py-2"
    >
      <div
        data-slot="operation-track"
        aria-hidden="true"
        className="relative mb-3 h-4"
        style={{ marginInline: `${50 / steps.length}%` }}
      >
        {steps.slice(0, -1).map((step, index) => (
          <FlowWire
            key={step.id}
            filled={filledInto(index + 1)}
            pulsing={pulsingInto(index + 1)}
            animate={animate}
            className="absolute top-1/2 -translate-y-1/2"
            style={{ left: at(index), width: `${100 / last}%` }}
          />
        ))}
        {steps.map((step, index) => (
          <FlowNode
            key={step.id}
            state={stateOf(index)}
            current={index === current}
            animate={animate}
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ left: at(index) }}
          />
        ))}
      </div>
      <ol
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
        }}
      >
        {steps.map((step, index) => {
          const state = stateOf(index);
          return (
            <li
              key={step.id}
              aria-current={index === current ? "step" : undefined}
              data-node-state={state}
              className="min-w-0 px-1.5 text-center"
            >
              <p className={cn("break-words", labelClass(state))}>
                {step.label}
              </p>
              <div className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
                {step.detail}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function labelClass(state: NodeState) {
  return cn(
    "text-xs font-medium transition-colors duration-200",
    state === "pending" ? "text-muted-foreground" : "text-foreground",
    state === "failed" && "text-destructive-text",
  );
}

/** The wire into a station: it fills as the station settles and carries the busy pulse. */
function FlowWire({
  filled,
  pulsing,
  animate,
  className,
  style,
}: {
  filled: boolean;
  pulsing: boolean;
  animate: boolean;
  className: string;
  style?: CSSProperties;
}) {
  return (
    <span
      data-slot="operation-wire"
      data-filled={filled}
      aria-hidden="true"
      className={cn("h-0.5 rounded-full bg-border", className)}
      style={style}
    >
      <motion.span
        className="absolute inset-y-0 left-0 rounded-full bg-foreground"
        initial={false}
        animate={{ width: filled ? "100%" : "0%" }}
        transition={{ duration: animate ? 0.35 : 0, ease: MOTION_EASE_OUT }}
      />
      {pulsing && (
        <motion.span
          data-slot="operation-pulse"
          className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
          initial={false}
          animate={{ left: animate ? ["0%", "100%"] : "100%" }}
          transition={
            animate
              ? {
                  duration: 1.1,
                  repeat: Number.POSITIVE_INFINITY,
                  ease: "easeInOut",
                }
              : { duration: 0 }
          }
        />
      )}
    </span>
  );
}

/** A station: a check once settled, a ring or a cross where the operation is, a dot ahead of it. */
function FlowNode({
  state,
  current,
  animate,
  className,
  style,
}: {
  state: NodeState;
  current: boolean;
  animate: boolean;
  className: string;
  style?: CSSProperties;
}) {
  return (
    <span
      data-slot={current ? "operation-marker" : "operation-node"}
      data-node-state={state}
      aria-hidden="true"
      className={cn(
        "grid place-items-center rounded-full",
        className,
        state === "pending" ? "size-1.5 bg-muted-foreground" : "size-3.5",
        state === "done" && "bg-foreground text-background",
        state === "active" && "border-2 border-foreground bg-background",
        state === "failed" &&
          "border-2 border-destructive bg-background text-destructive-text",
      )}
      style={style}
    >
      {state === "done" && (
        <svg
          aria-hidden="true"
          viewBox="0 0 10 10"
          className="size-2"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <motion.path
            d="M2 5.2 L4.2 7.4 L8 3"
            initial={animate ? { pathLength: 0 } : false}
            animate={{ pathLength: 1 }}
            transition={{ duration: animate ? 0.25 : 0, ease: "easeOut" }}
          />
        </svg>
      )}
      {state === "failed" && (
        <svg
          aria-hidden="true"
          viewBox="0 0 10 10"
          className="size-2"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        >
          <motion.path
            d="M2.5 2.5 L7.5 7.5 M7.5 2.5 L2.5 7.5"
            initial={animate ? { pathLength: 0 } : false}
            animate={{ pathLength: 1 }}
            transition={{ duration: animate ? 0.25 : 0, ease: "easeOut" }}
          />
        </svg>
      )}
      {state === "active" && (
        <span className="size-1 rounded-full bg-foreground" />
      )}
    </span>
  );
}
