"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  LuArrowRight,
  LuCookie,
  LuPause,
  LuPencil,
  LuTrash2,
  LuTriangleAlert,
} from "react-icons/lu";
import type { RunFilter } from "@/components/cookie-bot-activity";
import {
  clockInZone,
  describeCadence,
  formatDate,
  formatDateTime,
  formatDuration,
  formatShortDateTime,
  indexProfiles,
  minutesToClock,
  parseIso,
  RowAction,
  relativeRunLabel,
  StatusBadge,
  StatusDot,
  type StatusTone,
  scheduleBlockedReason,
  scheduleSlots,
  scheduleTone,
  sessionDisplayName,
  sessionPhaseLabel,
  sessionTone,
  TickingNumber,
  useNextDue,
  useNow,
} from "@/components/cookie-bot-shared";
import { DATA_TABLE_CLASSES } from "@/components/table-controls";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { RippleButton } from "@/components/ui/ripple";
import { SECTION_LABEL_CLASS } from "@/components/ui/settings-panel";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  CookieBotRun,
  CookieBotSchedule,
  RemoteHoursQuota,
} from "@/lib/cookie-bot";
import { MOTION_EASE_OUT } from "@/lib/motion";
import type { RemoteSessionState } from "@/lib/remote-sessions";
import { cn } from "@/lib/utils";
import type { BrowserProfile } from "@/types";

const CHART_DAYS = 30;
const NOW_TICK_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Times listed in a row before the rest fold into "+N". */
const VISIBLE_TIMES = 3;

interface CookieBotOverviewProps {
  schedules: CookieBotSchedule[];
  runs: CookieBotRun[];
  /** False when older runs exist that were not loaded. */
  runsComplete: boolean;
  live: RemoteSessionState[];
  quota: RemoteHoursQuota | null;
  profiles: BrowserProfile[];
  isLoading: boolean;
  currentUserId: string | null;
  canEditOthers: boolean;
  onEnrol: () => void;
  onEditSchedule: (schedule: CookieBotSchedule) => void;
  onRemoveSchedule: (schedule: CookieBotSchedule) => void;
  onJumpToActivity: (filter: RunFilter) => void;
}

export function CookieBotOverview({
  schedules,
  runs,
  runsComplete,
  live,
  quota,
  profiles,
  isLoading,
  currentUserId,
  canEditOthers,
  onEnrol,
  onEditSchedule,
  onRemoveSchedule,
  onJumpToActivity,
}: CookieBotOverviewProps) {
  const { t } = useTranslation();
  const now = useNow(NOW_TICK_MS);
  const due = useNextDue(schedules, now);
  const profileIndex = useMemo(() => indexProfiles(profiles), [profiles]);
  const recent = useMemo(() => summariseRecent(runs, now), [runs, now]);
  const exhausted =
    quota !== null && quota.granted_hours > 0 && quota.remaining_hours <= 0;
  const resetDate = formatDate(quota?.period_end);

  if (!isLoading && schedules.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
        <span className="grid size-12 place-items-center rounded-2xl bg-foreground/5 text-muted-foreground">
          <LuCookie className="size-6" />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground">
            {t("cookieBot.empty.title")}
          </p>
          <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
            {t("cookieBot.empty.hint")}
          </p>
        </div>
        <RippleButton size="sm" onClick={onEnrol}>
          {t("cookieBot.empty.cta")}
        </RippleButton>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div
        data-slot="cookie-bot-summary"
        className="grid shrink-0 overflow-hidden rounded-xl bg-foreground/3 @2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
      >
        <NextRunSection
          live={live}
          due={due}
          now={now}
          profileIndex={profileIndex}
          onJumpToActivity={onJumpToActivity}
        />
        <RecentSection recent={recent} onJumpToActivity={onJumpToActivity} />
      </div>

      {exhausted && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2.5 rounded-xl bg-warning/10 px-4 py-2.5 text-xs text-warning-text"
        >
          <LuTriangleAlert className="size-4 shrink-0" aria-hidden="true" />
          <span>
            {resetDate
              ? t("cookieBot.hours.exhaustedOn", { date: resetDate })
              : t("cookieBot.hours.exhausted")}
          </span>
        </div>
      )}

      <MachineTimeChart
        runs={runs}
        runsComplete={runsComplete}
        isLoading={isLoading}
        now={now}
      />

      <FadingScrollArea
        className="min-h-0 flex-1"
        style={{ "--scroll-fade-top-offset": "32px" } as React.CSSProperties}
      >
        <Table
          className={cn(DATA_TABLE_CLASSES.table, "w-full")}
          containerClassName="overflow-visible"
        >
          <TableHeader className={DATA_TABLE_CLASSES.header}>
            <TableRow className={DATA_TABLE_CLASSES.headerRow}>
              <TableHead className={DATA_TABLE_CLASSES.head}>
                {t("cookieBot.enrolled.columnProfile")}
              </TableHead>
              <TableHead
                className={cn(
                  DATA_TABLE_CLASSES.head,
                  "hidden w-48 @xl:table-cell",
                )}
              >
                {t("cookieBot.tabs.schedule")}
              </TableHead>
              <TableHead className={cn(DATA_TABLE_CLASSES.head, "w-52")}>
                {t("cookieBot.enrolled.columnNextRun")}
              </TableHead>
              <TableHead
                className={cn(
                  DATA_TABLE_CLASSES.head,
                  "hidden w-36 @4xl:table-cell",
                )}
              >
                {t("cookieBot.enrolled.columnLastRun")}
              </TableHead>
              <TableHead className={cn(DATA_TABLE_CLASSES.head, "w-[4.75rem]")}>
                <span className="sr-only">{t("common.labels.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && schedules.length === 0
              ? Array.from({ length: 4 }, (_, i) => (
                  <TableRow
                    key={`enrolled-skeleton-${i}`}
                    className={DATA_TABLE_CLASSES.row}
                  >
                    <TableCell colSpan={5} className="h-12">
                      <div className="flex items-center gap-3">
                        <Skeleton
                          className="h-3"
                          style={{ width: `${30 + ((i * 17) % 40)}%` }}
                        />
                        <div className="flex-1" />
                        <Skeleton className="h-3 w-16" />
                        <Skeleton className="h-3 w-10" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              : schedules.map((schedule, index) => {
                  const mine =
                    !schedule.owner_user_id ||
                    schedule.owner_user_id === currentUserId;
                  return (
                    <EnrolledRow
                      key={`${schedule.owner_user_id ?? "me"}-${schedule.profile_id}`}
                      index={index}
                      schedule={schedule}
                      mine={mine}
                      editable={mine || canEditOthers}
                      exhausted={exhausted}
                      now={now}
                      onEdit={onEditSchedule}
                      onRemove={onRemoveSchedule}
                    />
                  );
                })}
          </TableBody>
        </Table>
      </FadingScrollArea>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

function NextRunSection({
  live,
  due,
  now,
  profileIndex,
  onJumpToActivity,
}: {
  live: RemoteSessionState[];
  due: ReturnType<typeof useNextDue>;
  now: number;
  profileIndex: Map<string, BrowserProfile>;
  onJumpToActivity: (filter: RunFilter) => void;
}) {
  const { t } = useTranslation();
  const running = live.length > 0;
  const { next, nextAt, dueCount, allBlocked } = due;

  return (
    <section
      data-slot="cookie-bot-next-run"
      className="flex min-w-0 flex-col gap-1.5 px-4 py-3"
    >
      <span className={cn(SECTION_LABEL_CLASS, "flex items-center gap-1.5")}>
        {running && (
          <StatusDot
            tone={sessionTone(live[0])}
            pulse={live[0].state === "provisioning"}
            className="size-1.5"
          />
        )}
        {running ? t("cookieBot.running.label") : t("cookieBot.next.label")}
      </span>

      {running ? (
        <>
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-base font-semibold tracking-tight text-foreground">
              {sessionDisplayName(live[0], profileIndex, undefined) ??
                t("cookieBot.live.unnamedSession")}
            </span>
            <StatusBadge tone={sessionTone(live[0])}>
              {sessionPhaseLabel(t, live[0])}
            </StatusBadge>
          </div>
          <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
            {live.length > 1 && (
              <span className="tabular-nums">
                {t("cookieBot.running.more", { count: live.length - 1 })}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                onJumpToActivity("all");
              }}
              className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-primary-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              {t("cookieBot.actions.viewActivity")}
              <LuArrowRight className="size-3" aria-hidden="true" />
            </button>
          </div>
        </>
      ) : next && nextAt ? (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default text-2xl leading-none font-semibold tracking-tight tabular-nums text-foreground">
                  {clockInZone(nextAt, next.timezone)}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {formatDateTime(nextAt.toISOString()) ?? ""}
              </TooltipContent>
            </Tooltip>
            <StatusBadge tone="live">
              {relativeRunLabel(t, nextAt, now, next.timezone)}
            </StatusBadge>
          </div>
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="min-w-0 truncate text-foreground">
              {next.profile_name}
            </span>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">{next.timezone}</span>
            {dueCount > 1 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="shrink-0 tabular-nums">
                  {t("cookieBot.next.dueSoon", { count: dueCount })}
                </span>
              </>
            )}
          </p>
        </>
      ) : (
        <p className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
          {allBlocked && (
            <LuTriangleAlert
              className="size-4 shrink-0 text-warning-text"
              aria-hidden="true"
            />
          )}
          {allBlocked
            ? t("cookieBot.next.blocked")
            : t("cookieBot.next.nothingScheduled")}
        </p>
      )}
    </section>
  );
}

function RecentSection({
  recent,
  onJumpToActivity,
}: {
  recent: ReturnType<typeof summariseRecent>;
  onJumpToActivity: (filter: RunFilter) => void;
}) {
  const { t } = useTranslation();
  const stats: {
    filter: RunFilter;
    tone: StatusTone;
    count: number;
    label: string;
  }[] = [
    {
      filter: "succeeded",
      tone: "success",
      count: recent.succeeded,
      label: t("cookieBot.history.filterComplete"),
    },
    {
      filter: "partial",
      tone: "warning",
      count: recent.partial,
      label: t("cookieBot.history.filterPartial"),
    },
    {
      filter: "skipped",
      tone: "warning",
      count: recent.skipped,
      label: t("cookieBot.runStatus.skipped"),
    },
    {
      filter: "failed",
      tone: "destructive",
      count: recent.failed,
      label: t("cookieBot.history.filterFailed"),
    },
  ];

  return (
    <section
      data-slot="cookie-bot-recent"
      className="flex min-w-0 flex-col gap-1.5 border-t border-foreground/6 px-4 py-3 @2xl:border-t-0 @2xl:border-l"
    >
      <span className={SECTION_LABEL_CLASS}>
        {t("cookieBot.lastDay.label")}
      </span>
      <div className="-mx-2 grid grid-cols-4 gap-1">
        {stats.map((stat) => (
          <button
            key={stat.filter}
            type="button"
            data-status={stat.filter}
            disabled={stat.count === 0}
            onClick={() => {
              onJumpToActivity(stat.filter);
            }}
            className="flex min-w-0 cursor-pointer flex-col items-start gap-1 rounded-lg px-2 py-1 text-left transition-colors duration-150 hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:hover:bg-transparent"
          >
            <TickingNumber
              value={stat.count}
              format={(value) => String(Math.round(value))}
              className={cn(
                "text-2xl leading-none font-semibold tracking-tight",
                stat.count === 0 ? "text-muted-foreground" : "text-foreground",
              )}
            />
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <StatusDot
                tone={stat.count === 0 ? "muted" : stat.tone}
                className="size-1.5"
              />
              <span className="truncate">{stat.label}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Machine time chart                                                         */
/* -------------------------------------------------------------------------- */

interface DayUsage {
  key: string;
  date: Date;
  seconds: number;
  runs: number;
}

/**
 * Machine time per local day, from run rows the server wrote. A day with no
 * run is a zero the chart draws as a stub, never a value it invents. When the
 * loaded page does not reach back the whole window, the chart starts the day
 * after the oldest loaded run, so a day it cannot see is not drawn as empty.
 */
function dailyUsage(
  runs: CookieBotRun[],
  runsComplete: boolean,
  todayStart: number,
): DayUsage[] {
  const first = new Date(todayStart);
  first.setDate(first.getDate() - (CHART_DAYS - 1));
  if (!runsComplete && runs.length > 0) {
    let oldest = Number.POSITIVE_INFINITY;
    for (const run of runs) {
      const at = parseIso(run.started_at ?? run.scheduled_for);
      if (at) oldest = Math.min(oldest, at.getTime());
    }
    if (Number.isFinite(oldest)) {
      const after = new Date(oldest);
      after.setHours(0, 0, 0, 0);
      after.setDate(after.getDate() + 1);
      const start = Math.min(after.getTime(), todayStart);
      if (start > first.getTime()) first.setTime(start);
    }
  }

  const days: DayUsage[] = [];
  const index = new Map<string, DayUsage>();
  for (
    const day = new Date(first);
    day.getTime() <= todayStart;
    day.setDate(day.getDate() + 1)
  ) {
    const entry = {
      key: dayKey(day),
      date: new Date(day),
      seconds: 0,
      runs: 0,
    };
    days.push(entry);
    index.set(entry.key, entry);
  }
  for (const run of runs) {
    const at = parseIso(run.started_at ?? run.scheduled_for);
    if (!at) continue;
    const entry = index.get(dayKey(at));
    if (!entry) continue;
    entry.seconds += Math.max(0, run.billed_seconds);
    entry.runs += 1;
  }
  return days;
}

const AXIS_STEPS = [5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440];

/** Round ticks from zero: at most three equal steps above the axis. */
function minutesAxis(maxMinutes: number): { top: number; ticks: number[] } {
  const step =
    AXIS_STEPS.find((candidate) => candidate * 3 >= maxMinutes) ??
    Math.ceil(maxMinutes / 3 / 1440) * 1440;
  const top = Math.max(step, Math.ceil(maxMinutes / step) * step);
  const ticks: number[] = [];
  for (let tick = 0; tick <= top; tick += step) ticks.push(tick);
  return { top, ticks };
}

function MachineTimeChart({
  runs,
  runsComplete,
  isLoading,
  now,
}: {
  runs: CookieBotRun[];
  runsComplete: boolean;
  isLoading: boolean;
  now: number;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();

  const todayStart = useMemo(() => {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
  }, [now]);
  const days = useMemo(
    () => dailyUsage(runs, runsComplete, todayStart),
    [runs, runsComplete, todayStart],
  );

  const totalSeconds = days.reduce((sum, day) => sum + day.seconds, 0);
  const maxMinutes = Math.max(0, ...days.map((day) => day.seconds / 60));
  const axis = maxMinutes > 0 ? minutesAxis(maxMinutes) : null;
  const stepIsHours = axis !== null && (axis.ticks[1] ?? 0) % 60 === 0;
  const tickLabel = (minutes: number) =>
    minutes === 0
      ? "0"
      : stepIsHours
        ? t("cookieBot.team.hours", { hours: minutes / 60 })
        : t("cookieBot.chart.minutes", { minutes });

  const short = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  });
  const firstDay = days[0]?.date ?? new Date(todayStart);
  const range =
    days.length > 1
      ? short.formatRange(firstDay, new Date(todayStart))
      : short.format(firstDay);
  const total =
    totalSeconds > 0
      ? t("cookieBot.chart.total", {
          duration: formatDuration(t, totalSeconds),
        })
      : null;
  const middle = Math.floor((days.length - 1) / 2);
  const plotHeight = "h-[clamp(84px,14vh,156px)]";

  return (
    <section
      data-slot="cookie-bot-usage-chart"
      className="flex shrink-0 flex-col gap-2.5 rounded-xl bg-foreground/3 px-4 pt-3 pb-2.5"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="text-sm font-medium text-foreground">
          {t("cookieBot.chart.machineTime")}
        </h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {total ? `${range} · ${total}` : range}
        </span>
      </header>

      {isLoading && runs.length === 0 ? (
        <Skeleton className={cn(plotHeight, "w-full rounded-lg")} />
      ) : (
        <div className="flex gap-2">
          {axis && (
            <div
              aria-hidden="true"
              className={cn(
                "relative w-9 shrink-0 text-[10px] tabular-nums text-muted-foreground",
                plotHeight,
              )}
            >
              {axis.ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute right-0 translate-y-1/2 leading-none whitespace-nowrap"
                  style={{ bottom: `${(tick / axis.top) * 100}%` }}
                >
                  {tickLabel(tick)}
                </span>
              ))}
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div
              role="img"
              aria-label={[t("cookieBot.chart.machineTime"), range, total]
                .filter(Boolean)
                .join(", ")}
              className={cn("relative", plotHeight)}
            >
              {axis?.ticks.map((tick) => (
                <span
                  key={tick}
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-x-0 h-px",
                    tick === 0 ? "bg-foreground/12" : "bg-foreground/6",
                  )}
                  style={{ bottom: `${(tick / axis.top) * 100}%` }}
                />
              ))}
              <div
                aria-hidden="true"
                className="absolute inset-0 flex items-end gap-[3px]"
              >
                {days.map((day, index) => (
                  <DayBar
                    key={day.key}
                    day={day}
                    today={index === days.length - 1}
                    height={axis ? (day.seconds / 60 / axis.top) * 100 : 0}
                    index={index}
                    reduceMotion={Boolean(reduceMotion)}
                  />
                ))}
              </div>
              {!axis && (
                <p className="absolute inset-0 grid place-items-center pb-3 text-xs text-muted-foreground">
                  {t("cookieBot.chart.empty")}
                </p>
              )}
            </div>
            <div
              aria-hidden="true"
              className="grid text-[10px] tabular-nums text-muted-foreground"
              style={{
                gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
                columnGap: 3,
              }}
            >
              {days.map((day, index) => {
                const last = index === days.length - 1;
                if (index !== 0 && index !== middle && !last) return null;
                if (index === middle && (index === 0 || days.length < 5)) {
                  return null;
                }
                return (
                  <span
                    key={day.key}
                    className={cn(
                      "whitespace-nowrap",
                      index === 0 && !last && "justify-self-start",
                      index === middle && "justify-self-center",
                      last && "justify-self-end font-medium text-foreground",
                    )}
                    style={{ gridColumnStart: index + 1 }}
                  >
                    {last ? t("cookieBot.next.today") : short.format(day.date)}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function DayBar({
  day,
  today,
  height,
  index,
  reduceMotion,
}: {
  day: DayUsage;
  today: boolean;
  height: number;
  index: number;
  reduceMotion: boolean;
}) {
  const { t } = useTranslation();
  // Bars draw in left to right once; a later change moves at once.
  const drawn = useRef(false);
  useEffect(() => {
    drawn.current = true;
  }, []);
  const delay = drawn.current ? 0 : Math.min(index * 0.012, 0.36);
  const label = day.date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          data-today={today || undefined}
          className={cn(
            "relative flex h-full min-w-0 flex-1 items-end justify-center rounded-[4px]",
            today && "bg-foreground/4",
          )}
        >
          {day.seconds > 0 ? (
            <motion.div
              initial={reduceMotion ? false : { height: "0%" }}
              animate={{ height: `${Math.max(height, 1.5)}%` }}
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : { duration: 0.5, ease: MOTION_EASE_OUT, delay }
              }
              className={cn(
                "w-full max-w-4 rounded-t-[3px]",
                today ? "bg-chart-1" : "bg-chart-1/70",
              )}
            />
          ) : (
            <span className="h-0.5 w-full max-w-4 rounded-full bg-foreground/10" />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <span className="block font-medium">
          {today ? `${t("cookieBot.next.today")} · ${label}` : label}
        </span>
        <span className="block tabular-nums opacity-80">
          {day.runs > 0
            ? `${formatDuration(t, day.seconds)} · ${t("cookieBot.chart.runs", { count: day.runs })}`
            : t("cookieBot.chart.noRuns")}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/* Enrolled table                                                             */
/* -------------------------------------------------------------------------- */

function EnrolledRow({
  index,
  schedule,
  mine,
  editable,
  exhausted,
  now,
  onEdit,
  onRemove,
}: {
  index: number;
  schedule: CookieBotSchedule;
  mine: boolean;
  editable: boolean;
  exhausted: boolean;
  now: number;
  onEdit: (schedule: CookieBotSchedule) => void;
  onRemove: (schedule: CookieBotSchedule) => void;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const blocked = scheduleBlockedReason(t, schedule);
  const slots = scheduleSlots(schedule);
  const times = [...new Set(slots.map((slot) => slot.run_at_minute))]
    .sort((a, b) => a - b)
    .map(minutesToClock);
  const shownTimes = times.slice(0, VISIBLE_TIMES);
  const hiddenTimes = times.length - shownTimes.length;
  const cadence = describeCadence(
    t,
    slots.reduce((mask, slot) => mask | slot.days_mask, 0),
  );
  const nextAt = parseIso(schedule.next_run_at);
  const lastRun = formatShortDateTime(schedule.last_run_at);

  return (
    <motion.tr
      data-slot="cookie-bot-enrolled-row"
      data-table-row={schedule.profile_id}
      data-profile-id={schedule.profile_id}
      initial={reduceMotion ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : {
              duration: 0.24,
              ease: MOTION_EASE_OUT,
              delay: Math.min(index * 0.03, 0.3),
            }
      }
      className={cn("transition-colors", DATA_TABLE_CLASSES.row)}
    >
      <TableCell className="h-12 max-w-0 py-1.5">
        <span className="flex min-w-0 items-center gap-2.5">
          <StatusDot tone={scheduleTone(schedule)} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-foreground">
              {schedule.profile_name}
            </span>
            {!mine && schedule.owner_email && (
              <span className="truncate text-[11px] text-muted-foreground">
                {schedule.owner_email}
              </span>
            )}
          </span>
        </span>
      </TableCell>
      <TableCell className="hidden max-w-0 py-1.5 @xl:table-cell">
        <span
          data-slot="cookie-bot-times"
          className="flex min-w-0 items-center gap-1 text-xs font-medium tabular-nums text-foreground"
        >
          <span className="truncate">{shownTimes.join(" · ")}</span>
          {hiddenTimes > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0 cursor-default rounded-sm bg-foreground/6 px-1 text-[10px] text-muted-foreground">
                  +{hiddenTimes}
                </span>
              </TooltipTrigger>
              <TooltipContent>{times.join(" · ")}</TooltipContent>
            </Tooltip>
          )}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {cadence} · {schedule.timezone}
        </span>
      </TableCell>
      {/* The server publishes why the next run would be refused on every read.
          A next-run time the enrolment cannot keep is worse than no time. */}
      <TableCell className="max-w-0 py-1.5">
        {blocked ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex min-w-0 cursor-default">
                <StatusBadge tone="warning" icon={LuTriangleAlert}>
                  {blocked}
                </StatusBadge>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">{blocked}</TooltipContent>
          </Tooltip>
        ) : exhausted ? (
          <StatusBadge tone="warning" icon={LuPause}>
            {t("cookieBot.enrolled.pausedNoHours")}
          </StatusBadge>
        ) : !schedule.enabled ? (
          <StatusBadge tone="muted" icon={LuPause}>
            {t("cookieBot.state.paused")}
          </StatusBadge>
        ) : nextAt ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex min-w-0 cursor-default items-baseline gap-1.5 text-xs">
                <span className="shrink-0 font-medium text-foreground">
                  {relativeRunLabel(t, nextAt, now, schedule.timezone)}
                </span>
                <span className="truncate tabular-nums text-muted-foreground">
                  {clockInZone(nextAt, schedule.timezone)}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {formatDateTime(schedule.next_run_at) ?? ""}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="hidden max-w-0 py-1.5 text-xs tabular-nums text-muted-foreground @4xl:table-cell">
        {lastRun ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="block cursor-default truncate">{lastRun}</span>
            </TooltipTrigger>
            <TooltipContent>
              {formatDateTime(schedule.last_run_at) ?? ""}
            </TooltipContent>
          </Tooltip>
        ) : (
          t("cookieBot.enrolled.neverRun")
        )}
      </TableCell>
      <TableCell className="py-1.5">
        <div className="flex items-center justify-end gap-0.5">
          <RowAction
            label={t("cookieBot.enrolled.edit")}
            forbidden={!editable}
            forbiddenReason={t("cookieBot.conflict.replaceForbidden")}
            onClick={() => {
              onEdit(schedule);
            }}
          >
            <LuPencil className="size-3.5" />
          </RowAction>
          <RowAction
            label={t("cookieBot.schedule.unenrol")}
            forbidden={!editable}
            forbiddenReason={t("cookieBot.conflict.replaceForbidden")}
            destructive
            onClick={() => {
              onRemove(schedule);
            }}
          >
            <LuTrash2 className="size-3.5" />
          </RowAction>
        </div>
      </TableCell>
    </motion.tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Derivations — all of these read run rows the server wrote. Nothing here     */
/* predicts, estimates or fills in a value the backend did not report.        */
/* -------------------------------------------------------------------------- */

function summariseRecent(runs: CookieBotRun[], now: number) {
  const cutoff = now - DAY_MS;
  let succeeded = 0;
  let partial = 0;
  let skipped = 0;
  let failed = 0;
  for (const run of runs) {
    const at = parseIso(run.started_at ?? run.scheduled_for);
    if (!at || at.getTime() < cutoff) continue;
    if (run.status === "succeeded") succeeded += 1;
    else if (run.status === "partial") partial += 1;
    else if (run.status === "skipped") skipped += 1;
    else if (run.status === "failed") failed += 1;
  }
  return { succeeded, partial, skipped, failed };
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
