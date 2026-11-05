"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuCheck,
  LuClock,
  LuHand,
  LuLoaderCircle,
  LuRotateCcw,
  LuSquare,
  LuX,
} from "react-icons/lu";
import { LiveFrame, LiveLine } from "@/components/agent-chat/live-view";
import {
  StateDot,
  statusLabelKey,
  useNumber,
} from "@/components/agent-tasks/parts";
import { Button } from "@/components/ui/button";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import type { ProfilePreview } from "@/hooks/use-profile-previews";
import {
  type AgentBatch,
  type AgentTask,
  dismissAgentBatch,
  isTaskMoving,
  retryAgentBatch,
  rowsForAttention,
  STATE_FILL,
  STATE_TEXT,
  stateCounts,
  stopAgentBatch,
  TASK_STATES,
  type TaskState,
  taskState,
} from "@/lib/agent-tasks";
import { parseBackendError, translateBackendError } from "@/lib/backend-errors";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";

/** The status a filter count is labelled with. */
const STATE_LABEL: Record<(typeof TASK_STATES)[number], string> = {
  working: "running",
  needs_you: "needs_approval",
  done: "done",
  failed: "failed",
};

type T = ReturnType<typeof useTranslation>["t"];

/** The one line a row shows: the newest step, or what the status means. */
function rowLine(t: T, task: AgentTask): string {
  if (task.status === "needs_approval") return t("agent.tasks.needsYou");
  if (task.status === "done" && task.result) return task.result;
  if (task.status === "failed" && task.error) {
    return parseBackendError(task.error)
      ? translateBackendError(t, task.error)
      : task.error;
  }
  if (task.lastStep && task.status !== "queued") return task.lastStep.text;
  return t(statusLabelKey(task.status));
}

/** One segment per profile, in the run's own order. */
function RunStrip({
  tasks,
  nameOf,
  label,
}: {
  tasks: AgentTask[];
  nameOf: (profileId: string) => string;
  label: string;
}) {
  const gap =
    tasks.length > 160 ? "gap-0" : tasks.length > 60 ? "gap-px" : "gap-0.5";
  return (
    <div
      role="img"
      aria-label={label}
      data-slot="agent-batch-strip"
      className={cn("flex h-1.5 w-full shrink-0", gap)}
    >
      {tasks.map((task) => (
        <span
          key={task.profileId}
          title={nameOf(task.profileId)}
          data-state={taskState(task.status)}
          className={cn(
            "relative h-full min-w-0 flex-1 overflow-hidden rounded-[2px] transition-colors duration-300 motion-reduce:transition-none",
            STATE_FILL[taskState(task.status)],
          )}
        >
          {isTaskMoving(task.status) && (
            <span className="absolute inset-0 animate-[agent-sweep_1.8s_ease-in-out_infinite] bg-linear-to-r from-transparent via-background/45 to-transparent motion-reduce:hidden" />
          )}
        </span>
      ))}
    </div>
  );
}

function StateFilters({
  counts,
  filter,
  onFilter,
}: {
  counts: Record<TaskState, number>;
  filter: TaskState | null;
  onFilter: (state: TaskState | null) => void;
}) {
  const { t } = useTranslation();
  const format = useNumber();
  return (
    <div
      role="group"
      aria-label={t("agent.tasks.filterLabel")}
      className="-mx-2 flex flex-wrap items-center gap-0.5"
    >
      {TASK_STATES.filter((state) => counts[state] > 0).map((state) => {
        const on = filter === state;
        return (
          <button
            key={state}
            type="button"
            aria-pressed={on}
            data-slot="agent-batch-filter"
            data-state={state}
            onClick={() => {
              onFilter(on ? null : state);
            }}
            className={cn(
              "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              on
                ? "bg-foreground/6 text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              aria-hidden="true"
              className={cn("size-1.5 rounded-full", STATE_FILL[state])}
            />
            {t(statusLabelKey(STATE_LABEL[state]))}
            <span className="tabular-nums text-foreground">
              {format(counts[state])}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const MARK_TEXT: Record<TaskState, string> = {
  working: "text-primary",
  needs_you: "text-warning-text",
  done: "text-success",
  failed: "text-destructive",
  idle: "text-muted-foreground",
};

/** What a tile shows over a profile with no picture to show. */
function TileMark({ state }: { state: TaskState }) {
  const icon =
    state === "done" ? (
      <LuCheck className="size-4" />
    ) : state === "failed" ? (
      <LuX className="size-4" />
    ) : state === "needs_you" ? (
      <LuHand className="size-4" />
    ) : state === "working" ? (
      <LuLoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
    ) : (
      <LuClock className="size-4" />
    );
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-9 place-items-center rounded-full bg-background",
        MARK_TEXT[state],
      )}
    >
      {icon}
    </span>
  );
}

function RunTile({
  task,
  name,
  image,
  onOpen,
}: {
  task: AgentTask;
  name: string;
  image: string | undefined;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const format = useNumber();
  const state = taskState(task.status);
  const moving = isTaskMoving(task.status);
  return (
    <li>
      <button
        type="button"
        data-slot="agent-batch-tile"
        data-profile-id={task.profileId}
        data-status={task.status}
        data-state={state}
        onClick={onOpen}
        className={cn(
          "group flex w-full cursor-pointer flex-col gap-2 rounded-2xl p-1.5 text-left transition-colors duration-150 motion-reduce:transition-none",
          FOCUS_RING,
          state === "needs_you"
            ? "bg-warning/10 hover:bg-warning/15"
            : "hover:bg-foreground/4",
        )}
      >
        <LiveFrame
          image={moving || state === "needs_you" ? image : undefined}
          mark={<TileMark state={state} />}
          className="aspect-[16/10] w-full rounded-xl"
        />
        <span className="flex min-w-0 flex-col gap-1 px-1 pb-1">
          <span className="flex min-w-0 items-center gap-2">
            <StateDot
              status={task.status}
              className={cn(
                moving && "animate-pulse motion-reduce:animate-none",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {name}
            </span>
            {task.creditsUsed > 0 && (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {t("agent.tasks.credits", { n: format(task.creditsUsed) })}
              </span>
            )}
          </span>
          <LiveLine
            text={rowLine(t, task)}
            className={cn("text-xs", STATE_TEXT[state])}
          />
        </span>
      </button>
    </li>
  );
}

/** A run on one or many profiles: how far it is, and every profile. */
export function RunView({
  batch,
  nameOf,
  previews,
  onOpen,
  onDismissed,
}: {
  batch: AgentBatch;
  nameOf: (profileId: string) => string;
  /** The live picture of each profile the run works in. */
  previews: Record<string, ProfilePreview>;
  onOpen: (profileId: string) => void;
  onDismissed: (batchId: string) => void;
}) {
  const { t } = useTranslation();
  const format = useNumber();
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<TaskState | null>(null);
  const { tally } = batch;
  const total = batch.tasks.length;
  const ended = tally.done + tally.failed + tally.stopped;
  const counts = useMemo(() => stateCounts(batch.tasks), [batch.tasks]);
  const shownFilter = filter && counts[filter] > 0 ? filter : null;
  const rows = useMemo(
    () => rowsForAttention(batch.tasks, shownFilter),
    [batch.tasks, shownFilter],
  );
  const progress = t("agent.tasks.progress", { done: ended, total });

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      data-slot="agent-batch"
      data-batch-id={batch.id}
      data-finished={batch.finished ? "true" : "false"}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
    >
      <header className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p
            data-slot="agent-batch-summary"
            className="flex flex-wrap gap-x-2 text-xs text-muted-foreground tabular-nums"
          >
            <span>{progress}</span>
            {tally.creditsUsed > 0 && (
              <span>
                {t("agent.tasks.credits", { n: format(tally.creditsUsed) })}
              </span>
            )}
            {batch.routineId && <span>{t("agent.tasks.fromRoutine")}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!batch.finished && (
            <Button
              type="button"
              variant="subtle"
              size="sm"
              disabled={busy || batch.stopping}
              data-slot="agent-batch-stop"
              className="h-7 gap-1.5 rounded-lg px-2 text-xs hover:bg-destructive/10 hover:text-destructive-text"
              onClick={() => void act(() => stopAgentBatch(batch.id))}
            >
              <LuSquare className="size-3 fill-current" aria-hidden="true" />
              {total > 1 ? t("agent.tasks.stopAll") : t("agent.tasks.stop")}
            </Button>
          )}
          {tally.failed > 0 && batch.finished && (
            <Button
              type="button"
              variant="subtle"
              size="sm"
              disabled={busy}
              data-slot="agent-batch-retry"
              className="h-7 gap-1.5 rounded-lg px-2 text-xs"
              onClick={() => void act(() => retryAgentBatch(batch.id))}
            >
              <LuRotateCcw className="size-3.5" aria-hidden="true" />
              {t("agent.tasks.retryFailed")}
            </Button>
          )}
          {batch.finished && (
            <Button
              type="button"
              variant="subtle"
              size="sm"
              disabled={busy}
              aria-label={t("agent.tasks.dismiss")}
              title={t("agent.tasks.dismiss")}
              data-slot="agent-batch-dismiss"
              className="h-7 rounded-lg px-2"
              onClick={() =>
                void act(async () => {
                  await dismissAgentBatch(batch.id);
                  onDismissed(batch.id);
                })
              }
            >
              <LuX className="size-3.5" />
            </Button>
          )}
        </div>
      </header>
      {total > 1 && (
        <div className="flex flex-col gap-2">
          <RunStrip tasks={batch.tasks} nameOf={nameOf} label={progress} />
          <StateFilters
            counts={counts}
            filter={shownFilter}
            onFilter={setFilter}
          />
        </div>
      )}
      <FadingScrollArea className="-mx-1 min-h-0 flex-1 px-1">
        <ul
          aria-label={t("agent.tasks.rowsLabel")}
          data-slot="agent-batch-grid"
          className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-1.5 pb-2"
        >
          {rows.map((task) => (
            <RunTile
              key={task.profileId}
              task={task}
              name={nameOf(task.profileId)}
              image={previews[task.profileId]?.image}
              onOpen={() => {
                onOpen(task.profileId);
              }}
            />
          ))}
        </ul>
      </FadingScrollArea>
    </article>
  );
}
