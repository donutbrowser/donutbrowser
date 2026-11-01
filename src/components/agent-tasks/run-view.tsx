"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion } from "motion/react";
import {
  type CSSProperties,
  type KeyboardEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  LuCheck,
  LuChevronDown,
  LuRotateCcw,
  LuSquare,
  LuX,
} from "react-icons/lu";
import {
  StateDot,
  statusLabelKey,
  useNumber,
} from "@/components/agent-tasks/parts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { useScrollFade } from "@/hooks/use-scroll-fade";
import {
  type AgentBatch,
  type AgentTask,
  dismissAgentBatch,
  isTaskMoving,
  promptTitle,
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
import { MOTION_EASE_OUT } from "@/lib/motion";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";

const ROW_HEIGHT = 46;
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

/** A line that crossfades when its text changes, in place. */
function LiveLine({ text, className }: { text: string; className?: string }) {
  const animate = useMotionAllowed();
  return (
    <span className={cn("relative block h-4 overflow-hidden", className)}>
      <AnimatePresence initial={false}>
        <motion.span
          key={text}
          initial={animate ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={
            animate
              ? { duration: 0.24, ease: MOTION_EASE_OUT }
              : { duration: 0 }
          }
          className="absolute inset-0 truncate leading-4"
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
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

function RunRow({
  id,
  task,
  name,
  open,
  cursor,
  top,
  onOpen,
}: {
  id: string;
  task: AgentTask;
  name: string;
  open: boolean;
  cursor: boolean;
  top: number;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const format = useNumber();
  const state = taskState(task.status);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox holds the focus and answers the keys for its rows
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={open}
      data-slot="agent-batch-tile"
      data-profile-id={task.profileId}
      data-status={task.status}
      data-state={state}
      onClick={onOpen}
      style={{ height: ROW_HEIGHT - 2, transform: `translateY(${top}px)` }}
      className={cn(
        "absolute inset-x-0 top-0 flex cursor-pointer flex-col justify-center gap-0.5 rounded-lg px-3 transition-colors duration-150",
        open
          ? "bg-primary/10"
          : state === "needs_you"
            ? "bg-warning/10 hover:bg-warning/15"
            : cursor
              ? "bg-foreground/5"
              : "hover:bg-foreground/4",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <StateDot status={task.status} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {name}
        </span>
        <span className="flex shrink-0 items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
          {task.stepCount > 0 && (
            <span>{t("agent.tasks.stepCount", { count: task.stepCount })}</span>
          )}
          {task.creditsUsed > 0 && (
            <span
              title={t("agent.tasks.credits", { n: format(task.creditsUsed) })}
            >
              {format(task.creditsUsed)}
            </span>
          )}
        </span>
      </span>
      <LiveLine
        text={rowLine(t, task)}
        className={cn("pl-4 text-xs", STATE_TEXT[state])}
      />
    </div>
  );
}

/** The profiles of a run, virtualized; arrows move, Enter opens. */
function RunRows({
  tasks,
  nameOf,
  openProfileId,
  onOpen,
  label,
}: {
  tasks: AgentTask[];
  nameOf: (profileId: string) => string;
  openProfileId: string | null;
  onOpen: (profileId: string) => void;
  label: string;
}) {
  const baseId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);
  const [cursor, setCursor] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const cursorIndex = Math.max(
    0,
    tasks.findIndex((task) => task.profileId === (cursor ?? openProfileId)),
  );
  const rowId = (index: number) => `${baseId}-row-${index}`;

  const move = (index: number) => {
    const next = Math.min(Math.max(index, 0), tasks.length - 1);
    if (next < 0) return;
    setCursor(tasks[next].profileId);
    virtualizer.scrollToIndex(next, { align: "auto" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        move(cursorIndex + 1);
        break;
      case "ArrowUp":
        move(cursorIndex - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(tasks.length - 1);
        break;
      case "Enter":
      case " ": {
        const task = tasks[cursorIndex];
        if (task) onOpen(task.profileId);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  const total = virtualizer.getTotalSize();
  return (
    <div
      ref={scrollRef}
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={tasks.length > 0 ? rowId(cursorIndex) : undefined}
      data-slot="agent-batch-rows"
      onKeyDown={onKeyDown}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setFocused(false);
        setCursor(null);
      }}
      style={{ "--rows-h": `${total}px` } as CSSProperties}
      className="scroll-fade -mx-1 h-[min(var(--rows-h),26rem)] shrink-0 overflow-y-auto rounded-xl px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring @3xl:h-auto @3xl:min-h-0 @3xl:flex-1"
    >
      <div className="relative" style={{ height: total }}>
        {virtualizer.getVirtualItems().map((item) => {
          const task = tasks[item.index];
          return (
            <RunRow
              key={task.profileId}
              id={rowId(item.index)}
              task={task}
              name={nameOf(task.profileId)}
              open={task.profileId === openProfileId}
              cursor={focused && item.index === cursorIndex}
              top={item.start}
              onOpen={() => {
                setCursor(task.profileId);
                onOpen(task.profileId);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/** A run on one or many profiles: what it asked, how far it is, every profile. */
export function RunView({
  batch,
  batches,
  nameOf,
  openProfileId,
  onOpen,
  onPickBatch,
  onDismissed,
}: {
  batch: AgentBatch;
  batches: AgentBatch[];
  nameOf: (profileId: string) => string;
  openProfileId: string | null;
  onOpen: (profileId: string) => void;
  onPickBatch: (batchId: string) => void;
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

  const title = (
    <span className="truncate text-sm font-medium">
      {promptTitle(batch.prompt)}
    </span>
  );

  return (
    <article
      data-slot="agent-batch"
      data-batch-id={batch.id}
      data-finished={batch.finished ? "true" : "false"}
      className="flex min-w-0 flex-col gap-3 @3xl:min-h-0 @3xl:flex-1"
    >
      <header className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {batches.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-slot="agent-batch-switch"
                  title={batch.prompt}
                  className="-mx-1.5 inline-flex max-w-full cursor-pointer items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-left transition-colors duration-150 hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-expanded:bg-foreground/5"
                >
                  {title}
                  <LuChevronDown
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-80">
                {batches.map((item) => {
                  const done =
                    item.tally.done + item.tally.failed + item.tally.stopped;
                  return (
                    <DropdownMenuItem
                      key={item.id}
                      data-slot="agent-batch-option"
                      onSelect={() => {
                        onPickBatch(item.id);
                      }}
                      className="gap-2"
                    >
                      <LuCheck
                        aria-hidden="true"
                        className={cn(
                          "size-3.5",
                          item.id === batch.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {promptTitle(item.prompt, 60)}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {done}/{item.tasks.length}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <h4 className="flex min-w-0" title={batch.prompt}>
              {title}
            </h4>
          )}
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
      <RunRows
        tasks={rows}
        nameOf={nameOf}
        openProfileId={openProfileId}
        onOpen={onOpen}
        label={t("agent.tasks.rowsLabel")}
      />
    </article>
  );
}
