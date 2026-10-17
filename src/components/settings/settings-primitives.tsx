"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useId,
} from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { useInputModality } from "@/hooks/use-input-modality";
import { MOTION_EASE_OUT, MOTION_SPRING_POSITION } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Layout springs run only for pointer users who allow motion. */
export function useSettingsMotion() {
  const reduceMotion = useReducedMotion();
  const inputModality = useInputModality();
  return !reduceMotion && inputModality === "pointer";
}

/** A nav target: an icon that lights up while the reader is in it, and a title. */
export function SettingsSection({
  id,
  icon,
  title,
  active,
  hidden,
  aside,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  active: boolean;
  hidden: boolean;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const titleId = `settings-section-${id}`;
  return (
    <section
      data-settings-section={id}
      tabIndex={-1}
      hidden={hidden}
      aria-labelledby={titleId}
      className="@container flex scroll-mt-3 flex-col gap-3 focus:outline-none"
    >
      <header className="flex min-h-8 items-center gap-2.5">
        <span
          aria-hidden="true"
          data-active={active}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-lg transition-colors duration-200 [&_svg]:size-3.5",
            active
              ? "bg-primary/12 text-primary-text"
              : "bg-foreground/6 text-muted-foreground",
          )}
        >
          {icon}
        </span>
        <h2 id={titleId} className="text-sm font-semibold tracking-tight">
          {title}
        </h2>
        {aside && (
          <div className="ml-auto flex items-center gap-2">{aside}</div>
        )}
      </header>
      {children}
    </section>
  );
}

/** A quiet card that holds rows separated by hairlines. */
export function SettingsCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "divide-y divide-foreground/6 rounded-xl bg-foreground/3",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Marks a setting whose draft differs from what is saved. */
export function ChangedDot({ show }: { show: boolean }) {
  const { t } = useTranslation();
  const animate = useSettingsMotion();
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.span
          role="img"
          aria-label={t("settings.changed")}
          title={t("settings.changed")}
          data-slot="settings-changed-dot"
          initial={animate ? { scale: 0, opacity: 0 } : false}
          animate={{ scale: 1, opacity: 1 }}
          exit={animate ? { scale: 0, opacity: 0 } : { opacity: 0 }}
          transition={
            animate
              ? { type: "spring", stiffness: 600, damping: 28 }
              : { duration: 0 }
          }
          className="inline-block size-1.5 shrink-0 rounded-full bg-primary"
        />
      )}
    </AnimatePresence>
  );
}

/**
 * One setting: what it is on the left, its control on the right. The control
 * drops under the text only when the two cannot share a line.
 */
export function SettingRow({
  label,
  description,
  htmlFor,
  changed = false,
  icon,
  children,
  className,
  slot,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  changed?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
  slot?: string;
}) {
  return (
    <div
      data-slot={slot}
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 px-4 py-3.5",
        className,
      )}
    >
      <div className="flex min-w-[min(100%,15rem)] flex-1 items-start gap-3">
        {icon}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Label
            htmlFor={htmlFor}
            className="inline-flex items-center gap-2 text-sm leading-snug font-medium"
          >
            {label}
            <ChangedDot show={changed} />
          </Label>
          {description && (
            <p className="text-xs leading-relaxed text-pretty text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>
      {children && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {children}
        </div>
      )}
    </div>
  );
}

/** A setting whose control needs the full width, under its text. */
export function SettingBlock({
  label,
  description,
  changed = false,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  changed?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className="flex flex-col gap-0.5">
        <span className="inline-flex items-center gap-2 text-sm leading-snug font-medium">
          {label}
          <ChangedDot show={changed} />
        </span>
        {description && (
          <p className="text-xs leading-relaxed text-pretty text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

/** A tinted square for a row's icon; `tone` colors it by state. */
export function RowIcon({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "primary" | "success" | "warning";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg transition-colors duration-200 [&_svg]:size-4",
        {
          muted: "bg-foreground/6 text-muted-foreground",
          primary: "bg-primary/12 text-primary-text",
          success: "bg-success/12 text-success-text",
          warning: "bg-warning/14 text-warning-text",
        }[tone],
      )}
    >
      {children}
    </span>
  );
}

interface ChoiceContextValue {
  value: string;
  select: (value: string) => void;
  indicatorId: string;
  animate: boolean;
}

const ChoiceContext = createContext<ChoiceContextValue | null>(null);

function useChoice() {
  const context = useContext(ChoiceContext);
  if (!context) throw new Error("ChoiceCard must be inside a ChoiceGroup");
  return context;
}

/** Arrow keys move the choice, as in any radio group. */
function moveChoice(event: KeyboardEvent<HTMLElement>) {
  const step = (
    {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
    } as Record<string, number>
  )[event.key];
  if (!step) return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="radio"]:not(:disabled)',
    ),
  ];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next = items[(index + step + items.length) % items.length];
  next.focus();
  next.click();
}

/**
 * A radio group of cards. The selection ring slides from the old card to the
 * new one, so the eye follows the change.
 */
export function ChoiceGroup({
  value,
  onValueChange,
  label,
  className,
  children,
  slot,
}: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  className?: string;
  children: ReactNode;
  slot?: string;
}) {
  const indicatorId = useId();
  const animate = useSettingsMotion();
  return (
    <ChoiceContext.Provider
      value={{ value, select: onValueChange, indicatorId, animate }}
    >
      <div
        role="radiogroup"
        aria-label={label}
        data-slot={slot}
        onKeyDown={moveChoice}
        className={className}
      >
        {children}
      </div>
    </ChoiceContext.Provider>
  );
}

export function ChoiceCard({
  value,
  children,
  className,
  slot,
  label,
}: {
  value: string;
  children: ReactNode;
  className?: string;
  slot?: string;
  label?: string;
}) {
  const { value: selectedValue, select, indicatorId, animate } = useChoice();
  const selected = selectedValue === value;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      tabIndex={selected ? 0 : -1}
      data-slot={slot}
      data-value={value}
      data-state={selected ? "checked" : "unchecked"}
      onClick={() => {
        if (!selected) select(value);
      }}
      className={cn(
        "group/choice relative isolate cursor-pointer rounded-xl text-left outline-none",
        "transition-[background-color,translate] duration-150 ease-[var(--ease-out)]",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {selected && (
        <motion.span
          aria-hidden="true"
          data-slot="settings-choice-indicator"
          layoutId={animate ? `choice-${indicatorId}` : undefined}
          initial={false}
          transition={animate ? MOTION_SPRING_POSITION : { duration: 0 }}
          className="pointer-events-none absolute -inset-px -z-10 rounded-[inherit] bg-primary/8 ring-2 ring-primary/70"
        />
      )}
      {children}
    </button>
  );
}

/**
 * A row of short options with a pill that slides to the chosen one, the same
 * motion as the section nav.
 */
export function SegmentedControl<T extends string | number>({
  value,
  onValueChange,
  options,
  label,
  id,
  slot,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  label: string;
  id?: string;
  slot?: string;
}) {
  const indicatorId = useId();
  const animate = useSettingsMotion();
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={label}
      data-slot={slot}
      onKeyDown={moveChoice}
      className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto scrollbar-none rounded-lg bg-foreground/5 p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            data-value={option.value}
            onClick={() => {
              if (!selected) onValueChange(option.value);
            }}
            className={cn(
              "relative isolate h-7 shrink-0 cursor-pointer rounded-md px-2.5 text-xs font-medium whitespace-nowrap outline-none",
              "transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {selected && (
              <motion.span
                aria-hidden="true"
                layoutId={animate ? `segment-${indicatorId}` : undefined}
                initial={false}
                transition={animate ? MOTION_SPRING_POSITION : { duration: 0 }}
                className="absolute inset-0 -z-10 rounded-md bg-background shadow-sm ring-1 ring-foreground/8"
              />
            )}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A check that draws itself in when `done` turns true. */
export function RuleCheck({ done, label }: { done: boolean; label: string }) {
  const animate = useSettingsMotion();
  return (
    <li
      data-done={done}
      className={cn(
        "flex items-center gap-1.5 text-xs transition-colors duration-200",
        done ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-4 place-items-center rounded-full transition-colors duration-200",
          done ? "bg-success/15 text-success-text" : "bg-foreground/6",
        )}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className="size-2.5"
          fill="none"
        >
          <motion.path
            d="M2.5 6.2 5 8.5l4.5-5"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={false}
            animate={{ pathLength: done ? 1 : 0, opacity: done ? 1 : 0 }}
            transition={
              animate
                ? { duration: 0.24, ease: MOTION_EASE_OUT }
                : { duration: 0 }
            }
          />
        </svg>
      </span>
      {label}
    </li>
  );
}
