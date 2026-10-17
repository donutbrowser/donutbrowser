"use client";

import { motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LuPencil, LuTrash2, LuTriangleAlert } from "react-icons/lu";
import {
  describeCadence,
  minuteOfDayInZone,
  minutesToClock,
  RowAction,
  StatusBadge,
  StatusDot,
  scheduleBlockedReason,
  scheduleTone,
  useNow,
} from "@/components/cookie-bot-shared";
import { DATA_TABLE_CLASSES } from "@/components/table-controls";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
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
import { useInputModality } from "@/hooks/use-input-modality";
import type { CookieBotSchedule } from "@/lib/cookie-bot";
import { MOTION_EASE_OUT } from "@/lib/motion";
import {
  DAY_MINUTES,
  daySegments,
  type ScheduleLane,
  scheduleLanes,
} from "@/lib/schedule-layout";
import { cn } from "@/lib/utils";

const HOUR_MARKS = [0, 6, 12, 18, 24];

interface CookieBotScheduleTabProps {
  schedules: CookieBotSchedule[];
  isLoading: boolean;
  currentUserId: string | null;
  canEditOthers: boolean;
  onEdit: (schedule: CookieBotSchedule) => void;
  onRemove: (schedule: CookieBotSchedule) => void;
}

interface ProfileRow {
  key: string;
  schedule: CookieBotSchedule;
  lanes: ScheduleLane[];
}

/** One row per enrolment, every start time of it on the same day track. */
function profileRows(lanes: ScheduleLane[]): ProfileRow[] {
  const rows = new Map<string, ProfileRow>();
  for (const lane of lanes) {
    const key = `${lane.schedule.owner_user_id ?? ""}:${lane.schedule.profile_id}`;
    const row = rows.get(key);
    if (row) row.lanes.push(lane);
    else rows.set(key, { key, schedule: lane.schedule, lanes: [lane] });
  }
  return [...rows.values()];
}

function percent(minutes: number): string {
  return `${(minutes / DAY_MINUTES) * 100}%`;
}

export function CookieBotScheduleTab({
  schedules,
  isLoading,
  currentUserId,
  canEditOthers,
  onEdit,
  onRemove,
}: CookieBotScheduleTabProps) {
  const { t } = useTranslation();
  const now = useNow(60_000);
  const groups = useMemo(
    () =>
      [...scheduleLanes(schedules)].map(([timezone, lanes]) => ({
        timezone,
        rows: profileRows(lanes),
      })),
    [schedules],
  );

  if (isLoading && !schedules.length)
    return <Skeleton className="h-40 w-full rounded-xl" />;
  if (!schedules.length)
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        {t("cookieBot.schedule.empty")}
      </p>
    );

  return (
    <FadingScrollArea className="min-h-0 flex-1">
      <div data-slot="schedule-timeline" className="flex flex-col gap-6 pb-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("appFeedback.requestedSchedule")}
        </p>
        {groups.map(({ timezone, rows }) => {
          const nowMinute = minuteOfDayInZone(now, timezone);
          return (
            <section key={timezone} aria-label={timezone} className="min-w-0">
              <header className="mb-2 flex items-baseline justify-between gap-3 px-1">
                <h3 className="truncate text-sm font-medium text-foreground">
                  {timezone || t("common.labels.default")}
                </h3>
                {nowMinute !== null && (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                    <span
                      aria-hidden="true"
                      className="h-3 w-px rounded-full bg-primary"
                    />
                    {t("cookieBot.schedule.localTime", {
                      time: minutesToClock(nowMinute),
                    })}
                  </span>
                )}
              </header>
              <Table
                className={cn(DATA_TABLE_CLASSES.table, "w-full")}
                containerClassName="overflow-visible"
              >
                <TableHeader className="[&_tr]:border-0">
                  <TableRow className={DATA_TABLE_CLASSES.headerRow}>
                    <TableHead
                      className={cn(DATA_TABLE_CLASSES.head, "w-[34%]")}
                    >
                      {t("cookieBot.enrolled.columnProfile")}
                    </TableHead>
                    <TableHead className={DATA_TABLE_CLASSES.head}>
                      <div
                        aria-hidden="true"
                        className="relative h-4 text-[10px] font-normal tabular-nums"
                      >
                        {HOUR_MARKS.map((hour) => (
                          <span
                            key={hour}
                            className={cn(
                              "absolute top-0.5 leading-none",
                              hour === 0
                                ? "translate-x-0"
                                : hour === 24
                                  ? "-translate-x-full"
                                  : "-translate-x-1/2",
                            )}
                            style={{ left: percent(hour * 60) }}
                          >
                            {`${String(hour).padStart(2, "0")}:00`}
                          </span>
                        ))}
                      </div>
                    </TableHead>
                    <TableHead
                      className={cn(DATA_TABLE_CLASSES.head, "w-[4.75rem]")}
                    >
                      <span className="sr-only">
                        {t("common.labels.actions")}
                      </span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, index) => (
                    <ScheduleRow
                      key={row.key}
                      row={row}
                      index={index}
                      timezone={timezone}
                      nowMinute={nowMinute}
                      editable={
                        !row.schedule.owner_user_id ||
                        row.schedule.owner_user_id === currentUserId ||
                        canEditOthers
                      }
                      showOwner={
                        Boolean(row.schedule.owner_email) &&
                        row.schedule.owner_user_id !== currentUserId
                      }
                      onEdit={onEdit}
                      onRemove={onRemove}
                    />
                  ))}
                </TableBody>
              </Table>
            </section>
          );
        })}
      </div>
    </FadingScrollArea>
  );
}

function ScheduleRow({
  row,
  index,
  timezone,
  nowMinute,
  editable,
  showOwner,
  onEdit,
  onRemove,
}: {
  row: ProfileRow;
  index: number;
  timezone: string;
  nowMinute: number | null;
  editable: boolean;
  showOwner: boolean;
  onEdit: (schedule: CookieBotSchedule) => void;
  onRemove: (schedule: CookieBotSchedule) => void;
}) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const modality = useInputModality();
  const { schedule, lanes } = row;
  const blocked = scheduleBlockedReason(t, schedule);
  const overlaps = lanes.reduce((sum, lane) => sum + lane.overlaps, 0);
  const days = lanes.reduce((mask, lane) => mask | lane.days, 0);
  const instant = Boolean(reduced) || modality === "keyboard";

  return (
    <motion.tr
      data-table-row={row.key}
      data-profile-id={schedule.profile_id}
      initial={instant ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        instant
          ? { duration: 0 }
          : {
              duration: 0.24,
              ease: MOTION_EASE_OUT,
              delay: Math.min(index * 0.03, 0.3),
            }
      }
      className={cn("transition-colors", DATA_TABLE_CLASSES.row)}
    >
      <TableCell className="max-w-0 py-2">
        <button
          type="button"
          disabled={!editable}
          onClick={() => onEdit(schedule)}
          className="flex w-full min-w-0 cursor-pointer items-start gap-2.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
        >
          <StatusDot tone={scheduleTone(schedule)} className="mt-1.5" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-foreground">
              {schedule.profile_name}
            </span>
            <span className="truncate text-[11px] tabular-nums text-muted-foreground">
              {lanes.map((lane) => minutesToClock(lane.minute)).join(" · ")}
              {" · "}
              {describeCadence(t, days)}
            </span>
            {showOwner && (
              <span className="truncate text-[11px] text-muted-foreground">
                {schedule.owner_email}
              </span>
            )}
          </span>
        </button>
        {(blocked || overlaps > 0) && (
          <div className="mt-1.5 flex min-w-0 flex-wrap gap-1 pl-[1.125rem]">
            {blocked && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex min-w-0 max-w-full cursor-default">
                    <StatusBadge tone="warning" icon={LuTriangleAlert}>
                      {blocked}
                    </StatusBadge>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-72">{blocked}</TooltipContent>
              </Tooltip>
            )}
            {overlaps > 0 && (
              <StatusBadge tone="warning">
                {t("appFeedback.overlappingBookings", { count: overlaps })}
              </StatusBadge>
            )}
          </div>
        )}
      </TableCell>
      <TableCell className="py-2 align-middle">
        <div className="relative h-7 min-w-[120px]">
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-1 bottom-1 rounded-md bg-foreground/4"
          />
          {HOUR_MARKS.slice(1, -1).map((hour) => (
            <span
              key={hour}
              aria-hidden="true"
              className="absolute top-1 bottom-1 w-px bg-foreground/8"
              style={{ left: percent(hour * 60) }}
            />
          ))}
          {lanes.map((lane) =>
            daySegments(lane.minute, lane.duration).map((segment, part) => {
              const tone = cn(
                "absolute top-1.5 bottom-1.5 min-w-1 rounded-[4px]",
                !schedule.enabled || blocked
                  ? "bg-muted-foreground/50"
                  : lane.overlaps > 0
                    ? "bg-warning"
                    : "bg-chart-1",
              );
              const width = percent(segment.end - segment.start);
              if (part > 0) {
                return (
                  <span
                    key={`${lane.id}-${part}`}
                    aria-hidden="true"
                    className={tone}
                    style={{ left: percent(segment.start), width }}
                  />
                );
              }
              return (
                <Tooltip key={lane.id}>
                  <TooltipTrigger asChild>
                    <motion.button
                      type="button"
                      data-slot="schedule-lane"
                      data-profile-id={schedule.profile_id}
                      data-minute={lane.minute}
                      data-overlaps={lane.overlaps}
                      disabled={!editable}
                      onClick={() => onEdit(schedule)}
                      aria-label={`${t("cookieBot.enrolled.edit")}: ${schedule.profile_name}, ${minutesToClock(lane.minute)}, ${timezone}`}
                      initial={false}
                      animate={{ left: percent(segment.start), width }}
                      transition={{
                        duration: instant ? 0 : 0.22,
                        ease: MOTION_EASE_OUT,
                      }}
                      className={cn(
                        tone,
                        "cursor-pointer outline-none transition-shadow duration-150 hover:ring-2 hover:ring-foreground/20 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                      )}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    <span className="tabular-nums">
                      {minutesToClock(lane.minute)}
                    </span>
                    {` · ${describeCadence(t, lane.days)} · `}
                    {t("cookieBot.chart.minutes", { minutes: lane.duration })}
                  </TooltipContent>
                </Tooltip>
              );
            }),
          )}
          {nowMinute !== null && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -top-2 -bottom-2 w-px bg-primary/70"
              style={{ left: percent(nowMinute) }}
            />
          )}
        </div>
      </TableCell>
      <TableCell className="py-2">
        <div className="flex items-center justify-end gap-0.5">
          <RowAction
            label={t("cookieBot.enrolled.edit")}
            forbidden={!editable}
            forbiddenReason={t("cookieBot.conflict.replaceForbidden")}
            onClick={() => onEdit(schedule)}
          >
            <LuPencil className="size-3.5" />
          </RowAction>
          <RowAction
            label={t("cookieBot.schedule.unenrol")}
            forbidden={!editable}
            forbiddenReason={t("cookieBot.conflict.replaceForbidden")}
            destructive
            onClick={() => onRemove(schedule)}
          >
            <LuTrash2 className="size-3.5" />
          </RowAction>
        </div>
      </TableCell>
    </motion.tr>
  );
}
