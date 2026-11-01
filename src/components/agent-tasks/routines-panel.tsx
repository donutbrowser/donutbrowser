"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuChevronRight,
  LuEllipsis,
  LuPencil,
  LuPlay,
  LuPlus,
  LuTrash2,
} from "react-icons/lu";
import { useTimeFormat } from "@/components/agent-console-parts";
import {
  StateDot,
  statusLabelKey,
  useNumber,
  useScheduleWords,
} from "@/components/agent-tasks/parts";
import { RoutineEditor } from "@/components/agent-tasks/routine-editor";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { RippleButton } from "@/components/ui/ripple";
import { Skeleton } from "@/components/ui/skeleton";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import {
  type AgentBatch,
  type AgentRoutine,
  type AgentRoutineBatch,
  type AgentRoutineRun,
  deleteAgentRoutine,
  groupRoutineRuns,
  listAgentRoutineRuns,
  listAgentRoutines,
  promptTitle,
  runAgentRoutine,
  stateCounts,
  TASK_STATES,
} from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { MOTION_DURATION, MOTION_EASE_OUT, MOTION_SPRING } from "@/lib/motion";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { BrowserProfile } from "@/types";

/** Dots shown before the rest is a count. */
const MAX_DOTS = 24;

/** A routine's runs, read again whenever `version` moves. */
function useRoutineRuns(routineId: string, version: number) {
  const [batches, setBatches] = useState<AgentRoutineBatch[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    // Read again each time another run finishes.
    if (version < 0) return;
    let cancelled = false;
    listAgentRoutineRuns(routineId)
      .then((list) => {
        if (cancelled) return;
        setBatches(groupRoutineRuns(list));
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError);
      });
    return () => {
      cancelled = true;
    };
  }, [routineId, version]);
  return { batches, error };
}

function RunDots({ runs }: { runs: AgentRoutineRun[] }) {
  const format = useNumber();
  const rest = runs.length - MAX_DOTS;
  return (
    <span className="flex items-center gap-1">
      {runs.slice(0, MAX_DOTS).map((run) => (
        <StateDot key={run.runId} status={run.status} className="size-1.5" />
      ))}
      {rest > 0 && (
        <span className="text-[11px] tabular-nums text-muted-foreground">
          +{format(rest)}
        </span>
      )}
    </span>
  );
}

/** "3 done, 1 failed", from the states that occurred. */
function BatchTotals({ runs }: { runs: AgentRoutineRun[] }) {
  const { t } = useTranslation();
  const format = useNumber();
  const counts = stateCounts(runs);
  const labels = {
    working: "running",
    needs_you: "needs_approval",
    done: "done",
    failed: "failed",
  } as const;
  return (
    <span className="flex gap-2 tabular-nums">
      {TASK_STATES.filter((state) => counts[state] > 0).map((state) => (
        <span key={state}>
          {t(statusLabelKey(labels[state]))} {format(counts[state])}
        </span>
      ))}
    </span>
  );
}

function BatchLine({
  batch,
  profileNames,
  open,
  onToggle,
  now,
}: {
  batch: AgentRoutineBatch;
  profileNames: Map<string, string>;
  open: boolean;
  onToggle: () => void;
  now: number;
}) {
  const { t } = useTranslation();
  const format = useNumber();
  const { relative } = useTimeFormat();
  return (
    <li data-slot="agent-routine-batch" className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-8 cursor-pointer items-center gap-3 rounded-lg px-2 text-left text-xs text-muted-foreground transition-colors duration-150 hover:bg-foreground/4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <LuChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="w-24 shrink-0 truncate text-foreground">
          {batch.at !== null && relative(batch.at, now)}
        </span>
        <RunDots runs={batch.runs} />
        <span className="ml-auto flex shrink-0 items-center gap-3">
          <BatchTotals runs={batch.runs} />
          {batch.creditsUsed > 0 && (
            <span className="tabular-nums">
              {t("agent.tasks.credits", { n: format(batch.creditsUsed) })}
            </span>
          )}
        </span>
      </button>
      {open && (
        <ul className="flex flex-col pb-1 pl-8">
          {batch.runs.map((run) => (
            <li
              key={run.runId}
              data-slot="agent-routine-run"
              className="flex h-7 items-center gap-2 px-2 text-xs"
              title={run.summary ?? run.error ?? undefined}
            >
              <StateDot status={run.status} className="size-1.5" />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {(run.profileId && profileNames.get(run.profileId)) ??
                  t("agent.tasks.unknownProfile")}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {t(statusLabelKey(run.status))}
              </span>
              {run.creditsUsed != null && (
                <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
                  {t("agent.tasks.credits", { n: format(run.creditsUsed) })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function RunHistory({
  batches,
  error,
  profileNames,
}: {
  batches: AgentRoutineBatch[] | null;
  error: unknown;
  profileNames: Map<string, string>;
}) {
  const { t } = useTranslation();
  const newest = batches?.[0]?.batchId ?? null;
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const now = Date.now();
  if (error !== null) {
    return (
      <p className="px-2 text-xs text-destructive-text">
        {translateBackendError(t, error)}
      </p>
    );
  }
  if (batches === null) return <Skeleton className="h-8 w-full" />;
  if (batches.length === 0) {
    return (
      <p className="px-2 text-xs text-muted-foreground">
        {t("agent.routines.noRuns")}
      </p>
    );
  }
  return (
    <ul data-slot="agent-routine-runs" className="flex flex-col">
      {batches.slice(0, 20).map((batch) => {
        const open = toggled[batch.batchId] ?? batch.batchId === newest;
        return (
          <BatchLine
            key={batch.batchId}
            batch={batch}
            profileNames={profileNames}
            open={open}
            now={now}
            onToggle={() => {
              setToggled((current) => ({ ...current, [batch.batchId]: !open }));
            }}
          />
        );
      })}
    </ul>
  );
}

function RoutineRow({
  routine,
  index,
  version,
  profileNames,
  running,
  onRun,
  onEdit,
  onDelete,
}: {
  routine: AgentRoutine;
  index: number;
  version: number;
  profileNames: Map<string, string>;
  running: string | null;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const animate = useMotionAllowed();
  const { relative } = useTimeFormat();
  const scheduleWords = useScheduleWords();
  const { batches, error } = useRoutineRuns(routine.id, version);
  const [open, setOpen] = useState(false);
  const last = batches?.[0] ?? null;

  return (
    <motion.div
      data-slot="agent-routine"
      data-routine-id={routine.id}
      layout={animate ? "position" : false}
      initial={animate ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={
        animate
          ? {
              opacity: 0,
              scale: 0.98,
              transition: { duration: MOTION_DURATION.fast },
            }
          : { opacity: 0, transition: { duration: 0 } }
      }
      transition={
        animate
          ? { ...MOTION_SPRING.gentle, delay: Math.min(index, 12) * 0.03 }
          : { duration: 0 }
      }
      className={cn(
        "flex flex-col gap-2 rounded-xl px-3 py-3 transition-colors duration-150",
        open ? "bg-foreground/3" : "hover:bg-foreground/3",
      )}
    >
      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{routine.name}</span>
          <span
            className="truncate text-xs text-muted-foreground"
            title={routine.prompt}
          >
            {promptTitle(routine.prompt, 140)}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {t("agent.tasks.profileCount", {
              count: routine.profileIds.length,
            })}
            {" · "}
            {scheduleWords(routine.schedule)}
          </span>
        </div>
        {last ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={t("agent.routines.history")}
            data-slot="agent-routine-history"
            onClick={() => {
              setOpen(!open);
            }}
            className="hidden shrink-0 cursor-pointer flex-col items-end gap-1.5 rounded-lg px-2 py-1.5 transition-colors duration-150 hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-expanded:bg-foreground/5 @md:flex"
          >
            <RunDots runs={last.runs} />
            <span className="text-[11px] text-muted-foreground">
              {last.at !== null
                ? t("agent.routines.lastRun", {
                    when: relative(last.at, Date.now()),
                  })
                : t("agent.routines.history")}
            </span>
          </button>
        ) : (
          batches !== null && (
            <span className="hidden shrink-0 px-2 text-[11px] text-muted-foreground @md:block">
              {t("agent.routines.noRuns")}
            </span>
          )
        )}
        <Button
          variant="soft"
          size="sm"
          data-slot="agent-routine-run-now"
          className="h-8 gap-1.5 rounded-lg text-xs"
          disabled={running !== null || routine.profileIds.length === 0}
          aria-busy={running === routine.id}
          aria-label={t("agent.routines.runAria", { name: routine.name })}
          onClick={onRun}
        >
          <LuPlay className="size-3.5" aria-hidden="true" />
          {t("agent.routines.run")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="subtle"
              size="sm"
              data-slot="agent-routine-menu"
              aria-label={t("agent.routines.menuAria", { name: routine.name })}
              className="size-8 rounded-lg p-0"
            >
              <LuEllipsis className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem data-slot="agent-routine-edit" onSelect={onEdit}>
              <LuPencil aria-hidden="true" />
              {t("common.buttons.edit")}
            </DropdownMenuItem>
            {last && (
              <DropdownMenuItem
                onSelect={() => {
                  setOpen(true);
                }}
              >
                <LuChevronRight aria-hidden="true" />
                {t("agent.routines.history")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              data-slot="agent-routine-delete"
              variant="destructive"
              onSelect={onDelete}
            >
              <LuTrash2 aria-hidden="true" />
              {t("common.buttons.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={animate ? { opacity: 0, y: -2 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: animate ? 0.1 : 0 } }}
            transition={
              animate
                ? { duration: MOTION_DURATION.base, ease: MOTION_EASE_OUT }
                : { duration: 0 }
            }
          >
            <RunHistory
              batches={batches}
              error={error}
              profileNames={profileNames}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** The routine library: saved tasks, the profiles they run on, and their runs. */
export function AgentRoutinesPanel({
  profiles,
  canSchedule,
  finishedRuns,
  onRan,
}: {
  profiles: BrowserProfile[];
  canSchedule: boolean;
  /** Moves when a run finishes, so the run summaries are read again. */
  finishedRuns: number;
  onRan: (batch: AgentBatch) => void;
}) {
  const { t } = useTranslation();
  const [routines, setRoutines] = useState<AgentRoutine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<AgentRoutine | "new" | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AgentRoutine | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  const profileNames = new Map(profiles.map((p) => [p.id, p.name]));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRoutines(await listAgentRoutines());
      setError(null);
    } catch (loadError) {
      setError(loadError);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (routine: AgentRoutine) => {
    setRunning(routine.id);
    try {
      onRan(await runAgentRoutine(routine.id));
    } catch (runError) {
      showErrorToast(translateBackendError(t, runError));
    } finally {
      setRunning(null);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setIsRemoving(true);
    try {
      await deleteAgentRoutine(removing.id);
      setRemoving(null);
      void load();
    } catch (removeError) {
      showErrorToast(translateBackendError(t, removeError));
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <div
      data-slot="agent-routines"
      className="@container flex min-h-0 flex-1 flex-col gap-3"
    >
      <div className="flex shrink-0 items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("agent.routines.hint")}
        </p>
        <RippleButton
          size="sm"
          data-slot="agent-routine-new"
          className="flex h-8 items-center gap-1.5 rounded-lg text-xs"
          disabled={editing !== null}
          onClick={() => {
            setEditing("new");
          }}
        >
          <LuPlus className="size-3.5" />
          {t("agent.routines.new")}
        </RippleButton>
      </div>

      {error !== null && (
        <p className="shrink-0 rounded-xl bg-destructive/10 p-3 text-sm text-destructive-text">
          {translateBackendError(t, error)}
        </p>
      )}

      {editing !== null && (
        <RoutineEditor
          key={editing === "new" ? "new" : editing.id}
          routine={editing === "new" ? null : editing}
          profiles={profiles}
          canSchedule={canSchedule}
          onCancel={() => {
            setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      <FadingScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5">
          {loading && routines.length === 0 ? (
            Array.from({ length: 3 }, (_, index) => (
              <Skeleton
                key={`agent-routine-skeleton-${index}`}
                className="h-16 w-full rounded-xl"
              />
            ))
          ) : routines.length === 0 ? (
            <p
              data-slot="agent-routines-empty"
              className="py-16 text-center text-sm text-muted-foreground"
            >
              {t("agent.routines.empty")}
            </p>
          ) : (
            <AnimatePresence initial={false} mode="popLayout">
              {routines.map((routine, index) => (
                <RoutineRow
                  key={routine.id}
                  routine={routine}
                  index={index}
                  version={finishedRuns}
                  profileNames={profileNames}
                  running={running}
                  onRun={() => void run(routine)}
                  onEdit={() => {
                    setEditing(routine);
                  }}
                  onDelete={() => {
                    setRemoving(routine);
                  }}
                />
              ))}
            </AnimatePresence>
          )}
        </div>
      </FadingScrollArea>

      <DeleteConfirmationDialog
        isOpen={removing !== null}
        onClose={() => {
          setRemoving(null);
        }}
        onConfirm={() => {
          void remove();
        }}
        title={t("agent.routines.deleteTitle", { name: removing?.name ?? "" })}
        description={t("agent.routines.deleteDescription")}
        confirmButtonText={t("common.buttons.delete")}
        isLoading={isRemoving}
      />
    </div>
  );
}
