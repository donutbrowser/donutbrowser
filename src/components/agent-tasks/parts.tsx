"use client";

import { type ReactNode, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuChevronsUpDown, LuSettings2 } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  type AgentAutonomy,
  type AgentCredits,
  type AgentRoutineSchedule,
  type AgentTaskStatus,
  creditsLeft,
  cronWords,
  isWebUrl,
  MAX_CONCURRENCY,
  STATE_FILL,
  TASK_STATUSES,
  taskState,
} from "@/lib/agent-tasks";
import { cn } from "@/lib/utils";
import type { BrowserProfile, GroupWithCount } from "@/types";

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

/** The profiles of each group that has any among `profiles`. */
function groupMembers(
  profiles: BrowserProfile[],
  groups: Pick<GroupWithCount, "id" | "name">[],
) {
  return groups
    .map((group) => ({
      ...group,
      ids: profiles
        .filter((profile) => profile.group_id === group.id)
        .map((profile) => profile.id),
    }))
    .filter((group) => group.ids.length > 0);
}

/**
 * Choose any number of profiles, or exactly one, with search. With `groups`,
 * a group picks all its profiles. `noneLabel` makes a single choice optional:
 * it names the empty choice and lists it first.
 */
export function ProfilePicker({
  id,
  profiles,
  groups = [],
  selected,
  onChange,
  disabled,
  single = false,
  noneLabel,
  className,
}: {
  id?: string;
  profiles: BrowserProfile[];
  groups?: Pick<GroupWithCount, "id" | "name">[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  single?: boolean;
  noneLabel?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const chosen = new Set(selected);
  const known = profiles.filter((profile) => chosen.has(profile.id));
  const members = single ? [] : groupMembers(profiles, groups);
  const isWhole = (ids: string[]) => ids.every((member) => chosen.has(member));
  const wholeGroup = members.find(
    (group) => group.ids.length === known.length && isWhole(group.ids),
  );
  const label =
    known.length === 0
      ? (noneLabel ??
        t(single ? "agent.chat.chooseProfile" : "agent.tasks.chooseProfiles"))
      : known.length === 1
        ? known[0].name
        : (wholeGroup?.name ??
          t("agent.tasks.profileCount", { count: known.length }));

  const toggle = (profileId: string) => {
    if (single) {
      onChange([profileId]);
      setOpen(false);
      return;
    }
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
          className={cn(
            "h-8 max-w-56 justify-between gap-1.5 rounded-lg text-xs",
            className,
          )}
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
            {(!single || noneLabel) && (
              <CommandGroup>
                {single && noneLabel && (
                  <CommandItem
                    value="__none__"
                    data-slot="agent-profile-none"
                    onSelect={() => {
                      onChange([]);
                      setOpen(false);
                    }}
                    className="text-muted-foreground"
                  >
                    <LuCheck
                      className={cn(
                        "size-3.5",
                        known.length === 0 ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden="true"
                    />
                    {noneLabel}
                  </CommandItem>
                )}
                {!single && (
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
                )}
              </CommandGroup>
            )}
            {members.length > 0 && (
              <CommandGroup heading={t("agent.chat.groups")}>
                {members.map((group) => {
                  const whole = isWhole(group.ids);
                  return (
                    <CommandItem
                      key={group.id}
                      value={`group ${group.name} ${group.id}`}
                      data-slot="agent-profile-group"
                      data-group-id={group.id}
                      onSelect={() => {
                        const ids = new Set(group.ids);
                        onChange(
                          whole
                            ? selected.filter((member) => !ids.has(member))
                            : [
                                ...selected,
                                ...group.ids.filter((m) => !chosen.has(m)),
                              ],
                        );
                      }}
                    >
                      <LuCheck
                        className={cn(
                          "size-3.5",
                          whole ? "opacity-100" : "opacity-0",
                        )}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {group.name}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {group.ids.length}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            <CommandGroup
              heading={
                members.length > 0 ? t("agent.chat.profiles") : undefined
              }
            >
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

/** How a run or a routine runs, beyond its words and profiles. */
export interface RunSettings {
  startUrl: string;
  autonomy: AgentAutonomy;
  maxCredits: string;
  concurrency: string;
}

export const DEFAULT_RUN_SETTINGS: RunSettings = {
  startUrl: "",
  autonomy: "ask",
  maxCredits: "",
  concurrency: "",
};

export function positiveInt(value: string, max?: number): number | null {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return max ? Math.min(parsed, max) : parsed;
}

export function startUrlInvalid(settings: RunSettings): boolean {
  const url = settings.startUrl.trim();
  return url.length > 0 && !isWebUrl(url);
}

const OPTION_LABEL = "text-xs font-medium text-muted-foreground";

/**
 * The start page, credit cap and how many at once, behind one button.
 * `autonomy` adds the choice to ask first; a routine always acts on its own.
 */
export function RunOptions({
  value,
  onChange,
  autonomy = false,
  creditCapLabel,
  align = "end",
}: {
  value: RunSettings;
  onChange: (next: RunSettings) => void;
  autonomy?: boolean;
  creditCapLabel: string;
  align?: "start" | "end";
}) {
  const { t } = useTranslation();
  const formId = useId();
  const set = (patch: Partial<RunSettings>) => {
    onChange({ ...value, ...patch });
  };
  const tuned =
    value.startUrl.trim() !== "" ||
    (autonomy && value.autonomy === "auto") ||
    value.maxCredits.trim() !== "" ||
    value.concurrency.trim() !== "";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="subtle"
          size="sm"
          data-slot="agent-run-options"
          aria-label={t("agent.tasks.options")}
          title={t("agent.tasks.options")}
          className={cn(
            "size-8 rounded-xl p-0",
            tuned && "bg-foreground/6 text-foreground",
          )}
        >
          <LuSettings2 className="size-3.5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="flex w-72 flex-col gap-3 p-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${formId}-url`} className={OPTION_LABEL}>
            {t("agent.tasks.startUrl")}
          </Label>
          <Input
            id={`${formId}-url`}
            value={value.startUrl}
            inputMode="url"
            placeholder="https://"
            aria-invalid={startUrlInvalid(value)}
            data-slot="agent-run-url"
            className="h-8 text-xs md:text-xs"
            onChange={(event) => {
              set({ startUrl: event.target.value });
            }}
          />
        </div>
        {autonomy && (
          <div className="flex flex-col gap-2">
            <span className={OPTION_LABEL}>{t("agent.tasks.autonomy")}</span>
            <RadioGroup
              value={value.autonomy}
              onValueChange={(next) => {
                set({ autonomy: next as AgentAutonomy });
              }}
              className="gap-2"
            >
              {(["ask", "auto"] as const).map((option) => (
                <div key={option} className="flex items-center gap-2">
                  <RadioGroupItem
                    id={`${formId}-autonomy-${option}`}
                    value={option}
                  />
                  <Label
                    htmlFor={`${formId}-autonomy-${option}`}
                    className="text-sm font-normal"
                  >
                    {t(`agent.tasks.autonomyOptions.${option}`)}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-credits`} className={OPTION_LABEL}>
              {creditCapLabel}
            </Label>
            <Input
              id={`${formId}-credits`}
              type="number"
              min={1}
              value={value.maxCredits}
              placeholder={t("agent.tasks.noCap")}
              className="h-8 text-xs md:text-xs"
              onChange={(event) => {
                set({ maxCredits: event.target.value });
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-concurrency`} className={OPTION_LABEL}>
              {t("agent.tasks.concurrency")}
            </Label>
            <Input
              id={`${formId}-concurrency`}
              type="number"
              min={1}
              max={MAX_CONCURRENCY}
              value={value.concurrency}
              placeholder={t("agent.tasks.concurrencyDefault")}
              className="h-8 text-xs md:text-xs"
              onChange={(event) => {
                set({ concurrency: event.target.value });
              }}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The head of the agent panel's main pane: what it shows, and its actions.
 * `lead` is the list button a narrow window shows.
 */
export function PaneHeader({
  lead,
  title,
  children,
}: {
  lead: ReactNode;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex min-h-8 shrink-0 items-center gap-2">
      {lead}
      <h3
        data-slot="chat-title"
        className="min-w-0 flex-1 truncate text-sm font-medium"
      >
        {title}
      </h3>
      {children}
    </header>
  );
}
