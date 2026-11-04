"use client";

import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuRepeat } from "react-icons/lu";
import { useScheduleWords } from "@/components/agent-tasks/parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  type AgentRoutineSchedule,
  isCron,
  localTimezone,
  REPEAT_PRESETS,
  type RepeatParts,
  type RepeatPreset,
  repeatCron,
  repeatParts,
} from "@/lib/agent-tasks";
import { cn } from "@/lib/utils";

/** Once (a chat or a run), saved to run by hand, or on a schedule. */
export type Repeat =
  | { kind: "once" }
  | { kind: "manual" }
  | { kind: "schedule"; schedule: AgentRoutineSchedule };

export function repeatOf(schedule: AgentRoutineSchedule | null): Repeat {
  return schedule ? { kind: "schedule", schedule } : { kind: "manual" };
}

/** The schedule a routine saves, or null to run it by hand. */
export function scheduleOf(repeat: Repeat): AgentRoutineSchedule | null {
  return repeat.kind === "schedule" ? repeat.schedule : null;
}

export function repeatInvalid(repeat: Repeat): boolean {
  return repeat.kind === "schedule" && !isCron(repeat.schedule.cron);
}

const TIMED: ReadonlySet<RepeatPreset> = new Set([
  "daily",
  "weekdays",
  "weekly",
]);

function clock(parts: RepeatParts): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

function Option({
  checked,
  disabled,
  label,
  slot,
  onSelect,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  slot: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      data-slot="agent-repeat-option"
      data-repeat={slot}
      onClick={onSelect}
      className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors duration-150 hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent motion-reduce:transition-none"
    >
      <LuCheck
        aria-hidden="true"
        className={cn("size-3.5", checked ? "opacity-100" : "opacity-0")}
      />
      {label}
    </button>
  );
}

/**
 * How often a task runs. Schedules need the plan; without it they show the
 * way to it instead.
 */
export function RepeatPicker({
  value,
  onChange,
  allowOnce,
  canSchedule,
  onUpgrade,
  labelled = false,
  className,
}: {
  value: Repeat;
  onChange: (next: Repeat) => void;
  /** Offer "Don't repeat", for a task that is not saved. */
  allowOnce: boolean;
  canSchedule: boolean;
  onUpgrade: () => void;
  /** Name the control even while the task runs once. */
  labelled?: boolean;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const formId = useId();
  const scheduleWords = useScheduleWords();
  const [open, setOpen] = useState(false);
  const [parts, setParts] = useState<RepeatParts>(() =>
    repeatParts(value.kind === "schedule" ? value.schedule.cron : "0 9 * * *"),
  );
  const preset = value.kind === "schedule" ? parts.preset : null;

  const weekdays = useMemo(
    () =>
      // 2026-01-04 is a Sunday, so day 0 + n is weekday n.
      Array.from({ length: 7 }, (_, day) => ({
        day,
        short: new Date(2026, 0, 4 + day).toLocaleDateString(i18n.language, {
          weekday: "narrow",
        }),
        long: new Date(2026, 0, 4 + day).toLocaleDateString(i18n.language, {
          weekday: "long",
        }),
      })),
    [i18n.language],
  );

  const schedule = (next: RepeatParts) => {
    setParts(next);
    onChange({
      kind: "schedule",
      schedule: {
        cron: repeatCron(next),
        timezone:
          (value.kind === "schedule" && value.schedule.timezone) ||
          localTimezone(),
      },
    });
  };

  const iconOnly = value.kind === "once" && allowOnce && !labelled;
  const label =
    value.kind === "once"
      ? t("agent.chat.repeat.label")
      : value.kind === "manual"
        ? t("agent.routines.manual")
        : scheduleWords(value.schedule);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={value.kind === "once" ? "subtle" : "soft"}
          size="sm"
          data-slot="agent-repeat"
          data-repeat={value.kind === "schedule" ? parts.preset : value.kind}
          aria-label={
            value.kind === "once" ? t("agent.chat.repeat.label") : undefined
          }
          title={label}
          className={cn(
            "h-8 max-w-56 gap-1.5 rounded-xl text-xs",
            iconOnly && "w-8 p-0",
            className,
          )}
        >
          <LuRepeat className="size-3.5" aria-hidden="true" />
          {!iconOnly && <span className="truncate">{label}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-64 flex-col gap-1 p-1.5">
        <div
          role="radiogroup"
          aria-label={t("agent.chat.repeat.label")}
          className="flex flex-col"
        >
          {allowOnce && (
            <Option
              slot="once"
              checked={value.kind === "once"}
              label={t("agent.chat.repeat.once")}
              onSelect={() => {
                onChange({ kind: "once" });
                setOpen(false);
              }}
            />
          )}
          <Option
            slot="manual"
            checked={value.kind === "manual"}
            label={t("agent.routines.manual")}
            onSelect={() => {
              onChange({ kind: "manual" });
              setOpen(false);
            }}
          />
          {REPEAT_PRESETS.map((option) => (
            <Option
              key={option}
              slot={option}
              checked={preset === option}
              disabled={!canSchedule}
              label={t(`agent.chat.repeat.${option}`)}
              onSelect={() => {
                // Custom starts from the schedule already chosen.
                schedule({
                  ...parts,
                  preset: option,
                  cron: option === "custom" ? repeatCron(parts) : parts.cron,
                });
              }}
            />
          ))}
        </div>
        {preset && TIMED.has(preset) && (
          <div className="flex flex-col gap-2 px-2 pt-1 pb-1.5">
            {preset === "weekly" && (
              <div
                role="radiogroup"
                aria-label={t("agent.chat.repeat.day")}
                className="flex gap-0.5"
              >
                {weekdays.map(({ day, short, long }) => (
                  <button
                    key={day}
                    type="button"
                    role="radio"
                    aria-checked={parts.weekday === day}
                    aria-label={long}
                    title={long}
                    onClick={() => {
                      schedule({ ...parts, weekday: day });
                    }}
                    className={cn(
                      "grid h-7 flex-1 cursor-pointer place-items-center rounded-md text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none",
                      parts.weekday === day
                        ? "bg-primary/10 text-foreground"
                        : "text-muted-foreground hover:bg-foreground/5",
                    )}
                  >
                    {short}
                  </button>
                ))}
              </div>
            )}
            <Label htmlFor={`${formId}-time`} className="sr-only">
              {t("agent.chat.repeat.at")}
            </Label>
            <Input
              id={`${formId}-time`}
              type="time"
              value={clock(parts)}
              data-slot="agent-repeat-time"
              className="h-8 text-xs md:text-xs"
              onChange={(event) => {
                const [hour, minute] = event.target.value
                  .split(":")
                  .map((part) => Number.parseInt(part, 10));
                if (Number.isFinite(hour) && Number.isFinite(minute)) {
                  schedule({ ...parts, hour, minute });
                }
              }}
            />
          </div>
        )}
        {preset === "custom" && (
          <div className="px-2 pt-1 pb-1.5">
            <Label htmlFor={`${formId}-cron`} className="sr-only">
              {t("agent.routines.cron")}
            </Label>
            <Input
              id={`${formId}-cron`}
              value={parts.cron}
              placeholder="0 9 * * 1-5"
              aria-invalid={!isCron(parts.cron)}
              data-slot="agent-repeat-cron"
              className="h-8 font-mono text-xs md:text-xs"
              onChange={(event) => {
                schedule({ ...parts, cron: event.target.value });
              }}
            />
          </div>
        )}
        {!canSchedule && (
          <div
            data-slot="agent-repeat-plan"
            className="flex items-center gap-2 px-2 pt-1 pb-1"
          >
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">
              {t("agent.chat.repeat.needsPlan")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="soft"
              className="h-7 rounded-lg text-xs"
              onClick={() => {
                setOpen(false);
                onUpgrade();
              }}
            >
              {t("agent.setup.planAction")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
