"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuChevronsUpDown } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  type AgentCredits,
  type AgentRoutineSchedule,
  type AgentTaskStatus,
  creditsLeft,
  cronWords,
  STATE_FILL,
  TASK_STATUSES,
  taskState,
} from "@/lib/agent-tasks";
import { cn } from "@/lib/utils";
import type { BrowserProfile } from "@/types";

export function useNumber() {
  const { i18n } = useTranslation();
  return useMemo(
    () => new Intl.NumberFormat(i18n.language).format,
    [i18n.language],
  );
}

/** A routine's schedule in words: "Weekdays at 09:00". */
export function useScheduleWords() {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  return useMemo(() => {
    const time = (hour: number, minute: number) =>
      new Date(2026, 0, 5, hour, minute).toLocaleTimeString(language, {
        hour: "2-digit",
        minute: "2-digit",
      });
    // 2026-01-04 is a Sunday, so day 0 + n is weekday n.
    const weekday = (day: number) =>
      new Date(2026, 0, 4 + day).toLocaleDateString(language, {
        weekday: "long",
      });
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return (schedule: AgentRoutineSchedule | null): string => {
      if (!schedule) return t("agent.routines.manual");
      const words = cronWords(schedule.cron);
      let text: string;
      switch (words.kind) {
        case "daily":
        case "weekdays":
        case "weekends":
          text = t(`agent.routines.every.${words.kind}`, {
            time: time(words.hour, words.minute),
          });
          break;
        case "weekly":
          text = t("agent.routines.every.weekly", {
            day: weekday(words.weekday),
            time: time(words.hour, words.minute),
          });
          break;
        case "hourly":
          text = t("agent.routines.every.hourly", { minute: words.minute });
          break;
        case "minutes":
          text = t("agent.routines.every.minutes", { count: words.every });
          break;
        default:
          text = t("agent.routines.every.custom", { cron: schedule.cron });
      }
      return schedule.timezone && schedule.timezone !== local
        ? `${text} (${schedule.timezone})`
        : text;
    };
  }, [t, language]);
}

/** The credits left this period, as a number and a thin bar. */
export function CreditsMeter({ credits }: { credits: AgentCredits | null }) {
  const { t } = useTranslation();
  const format = useNumber();
  if (!credits) return null;
  const left = creditsLeft(credits);
  if (!left) {
    return (
      <span data-slot="agent-credits" className="text-xs text-muted-foreground">
        {t("agent.credits.unlimited")}
      </span>
    );
  }
  const empty = left.left === 0;
  return (
    <div
      data-slot="agent-credits"
      className="flex items-center gap-2"
      title={t("agent.credits.detail", {
        used: format(credits.used),
        total: format(credits.allowance + credits.extra),
      })}
    >
      <span
        className={cn(
          "text-xs tabular-nums",
          empty ? "text-warning-text" : "text-muted-foreground",
        )}
      >
        {t("agent.credits.left", { n: format(left.left) })}
      </span>
      <span
        role="meter"
        aria-label={t("agent.credits.meter")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={100 - left.percentUsed}
        className="h-1 w-16 overflow-hidden rounded-full bg-foreground/8"
      >
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
            empty ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${100 - left.percentUsed}%` }}
        />
      </span>
    </div>
  );
}

/** Task statuses, and the run statuses only the cloud reports. */
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  ...TASK_STATUSES,
  "missed",
]);

/** A state's dot, in the state's one color. */
export function StateDot({
  status,
  className,
}: {
  status: AgentTaskStatus | string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full transition-colors duration-300 motion-reduce:transition-none",
        STATE_FILL[taskState(status)],
        className,
      )}
    />
  );
}

export function statusLabelKey(status: AgentTaskStatus | string): string {
  return `agent.tasks.status.${KNOWN_STATUSES.has(status) ? status : "unknown"}`;
}

export function TaskStatusLabel({
  status,
  className,
}: {
  status: AgentTaskStatus | string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <StateDot status={status} />
      {t(statusLabelKey(status))}
    </span>
  );
}

/** Choose any number of profiles, with search. */
export function ProfilePicker({
  id,
  profiles,
  selected,
  onChange,
  disabled,
}: {
  id?: string;
  profiles: BrowserProfile[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const chosen = new Set(selected);
  const known = profiles.filter((profile) => chosen.has(profile.id));
  const label =
    known.length === 0
      ? t("agent.tasks.chooseProfiles")
      : known.length === 1
        ? known[0].name
        : t("agent.tasks.profileCount", { count: known.length });

  const toggle = (profileId: string) => {
    onChange(
      chosen.has(profileId)
        ? selected.filter((idOf) => idOf !== profileId)
        : [...selected, profileId],
    );
  };
  const allChosen = profiles.length > 0 && known.length === profiles.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="soft"
          size="sm"
          disabled={disabled}
          data-slot="agent-profile-picker"
          className="h-8 max-w-56 justify-between gap-1.5 rounded-lg text-xs"
        >
          <span className="truncate">{label}</span>
          <LuChevronsUpDown className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder={t("agent.tasks.searchProfiles")} />
          <CommandList className="max-h-64">
            <CommandEmpty>{t("agent.tasks.noProfileMatch")}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__all__"
                data-slot="agent-profile-all"
                onSelect={() => {
                  onChange(allChosen ? [] : profiles.map((p) => p.id));
                }}
                className="text-muted-foreground"
              >
                {allChosen
                  ? t("agent.tasks.clearProfiles")
                  : t("agent.tasks.allProfiles")}
              </CommandItem>
              {profiles.map((profile) => (
                <CommandItem
                  key={profile.id}
                  value={`${profile.name} ${profile.id}`}
                  data-slot="agent-profile-option"
                  data-profile-id={profile.id}
                  onSelect={() => {
                    toggle(profile.id);
                  }}
                >
                  <LuCheck
                    className={cn(
                      "size-3.5",
                      chosen.has(profile.id) ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden="true"
                  />
                  <span className="truncate">{profile.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
