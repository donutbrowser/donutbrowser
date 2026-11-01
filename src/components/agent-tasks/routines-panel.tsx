"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronDown, LuPlay, LuPlus } from "react-icons/lu";
import { useTimeFormat } from "@/components/agent-console-parts";
import { TaskStatusLabel, useNumber } from "@/components/agent-tasks/parts";
import { RoutineEditor } from "@/components/agent-tasks/routine-editor";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { Button } from "@/components/ui/button";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { RippleButton } from "@/components/ui/ripple";
import { Skeleton } from "@/components/ui/skeleton";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import {
  type AgentBatch,
  type AgentRoutine,
  type AgentRoutineRun,
  deleteAgentRoutine,
  listAgentRoutineRuns,
  listAgentRoutines,
  runAgentRoutine,
} from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { MOTION_DURATION, MOTION_EASE_OUT, MOTION_SPRING } from "@/lib/motion";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { BrowserProfile } from "@/types";

function RunHistory({
  routineId,
  profileNames,
}: {
  routineId: string;
  profileNames: Map<string, string>;
}) {
  const { t } = useTranslation();
  const format = useNumber();
  const { relative } = useTimeFormat();
  const [runs, setRuns] = useState<AgentRoutineRun[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    listAgentRoutineRuns(routineId)
      .then((list) => {
        if (!cancelled) setRuns(list);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError);
      });
    return () => {
      cancelled = true;
    };
  }, [routineId]);

  if (error !== null) {
    return (
      <p className="px-1 text-xs text-destructive-text">
        {translateBackendError(t, error)}
      </p>
    );
  }
  if (runs === null) return <Skeleton className="h-8 w-full" />;
  if (runs.length === 0) {
    return (
      <p className="px-1 text-xs text-muted-foreground">
        {t("agent.routines.noRuns")}
      </p>
    );
  }
  const now = Date.now();
  return (
    <ul data-slot="agent-routine-runs" className="flex flex-col">
      {runs.slice(0, 20).map((run) => {
        const at = Date.parse(run.finishedAt ?? run.createdAt ?? "");
        return (
          <li
            key={run.runId}
            data-slot="agent-routine-run"
            className="flex items-center gap-3 rounded-lg px-1 py-1.5 text-xs"
          >
            <TaskStatusLabel status={run.status} className="w-28 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-foreground">
              {(run.profileId && profileNames.get(run.profileId)) ??
                t("agent.tasks.unknownProfile")}
            </span>
            {run.creditsUsed != null && (
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {t("agent.tasks.credits", { n: format(run.creditsUsed) })}
              </span>
            )}
            {Number.isFinite(at) && (
              <span className="shrink-0 text-muted-foreground">
                {relative(at, now)}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The routine library: saved tasks, the profiles they run on, and their runs. */
export function AgentRoutinesPanel({
  profiles,
  canSchedule,
  onRan,
}: {
  profiles: BrowserProfile[];
  canSchedule: boolean;
  onRan: (batch: AgentBatch) => void;
}) {
  const { t } = useTranslation();
  const animate = useMotionAllowed();
  const [routines, setRoutines] = useState<AgentRoutine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<AgentRoutine | "new" | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
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

  const summary = (routine: AgentRoutine) => {
    const parts = [
      t("agent.tasks.profileCount", { n: routine.profileIds.length }),
    ];
    parts.push(
      routine.schedule
        ? t("agent.routines.scheduleSummary", {
            cron: routine.schedule.cron,
            timezone: routine.schedule.timezone,
          })
        : t("agent.routines.manual"),
    );
    return parts.join(" · ");
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
        <div className="flex flex-col gap-1.5 pr-1">
          {loading && routines.length === 0 ? (
            Array.from({ length: 3 }, (_, index) => (
              <Skeleton
                key={`agent-routine-skeleton-${index}`}
                className="h-14 w-full rounded-xl"
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
              {routines.map((routine, index) => {
                const open = historyOf === routine.id;
                return (
                  <motion.div
                    key={routine.id}
                    data-slot="agent-routine"
                    data-routine-id={routine.id}
                    layout={animate ? "position" : false}
                    initial={animate ? { opacity: 0.6, y: 6 } : false}
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
                        ? {
                            ...MOTION_SPRING.gentle,
                            delay: Math.min(index, 12) * 0.02,
                          }
                        : { duration: 0 }
                    }
                    className="flex flex-col gap-2 rounded-xl bg-foreground/3 p-3 transition-colors duration-150 hover:bg-foreground/5"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium">
                          {routine.name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {summary(routine)}
                        </span>
                      </div>
                      <Button
                        variant="soft"
                        size="sm"
                        data-slot="agent-routine-run-now"
                        className="h-8 gap-1.5 rounded-lg text-xs"
                        disabled={
                          running !== null || routine.profileIds.length === 0
                        }
                        aria-busy={running === routine.id}
                        aria-label={t("agent.routines.runAria", {
                          name: routine.name,
                        })}
                        onClick={() => void run(routine)}
                      >
                        <LuPlay className="size-3.5" aria-hidden="true" />
                        {t("agent.routines.run")}
                      </Button>
                      <Button
                        variant="subtle"
                        size="sm"
                        aria-expanded={open}
                        data-slot="agent-routine-history"
                        className="h-8 gap-1 rounded-lg text-xs"
                        onClick={() => {
                          setHistoryOf(open ? null : routine.id);
                        }}
                      >
                        {t("agent.routines.history")}
                        <LuChevronDown
                          className={cn(
                            "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                            open && "rotate-180",
                          )}
                          aria-hidden="true"
                        />
                      </Button>
                      <Button
                        variant="soft"
                        size="sm"
                        className="h-8 rounded-lg text-xs"
                        aria-label={t("agent.routines.editAria", {
                          name: routine.name,
                        })}
                        onClick={() => {
                          setEditing(routine);
                        }}
                      >
                        {t("common.buttons.edit")}
                      </Button>
                      <Button
                        variant="subtle"
                        size="sm"
                        className="h-8 rounded-lg text-xs hover:bg-destructive/10 hover:text-destructive-text"
                        aria-label={t("agent.routines.deleteAria", {
                          name: routine.name,
                        })}
                        onClick={() => {
                          setRemoving(routine);
                        }}
                      >
                        {t("common.buttons.delete")}
                      </Button>
                    </div>
                    {open && (
                      <motion.div
                        initial={animate ? { opacity: 0.6, y: -2 } : false}
                        animate={{ opacity: 1, y: 0 }}
                        transition={
                          animate
                            ? {
                                duration: MOTION_DURATION.base,
                                ease: MOTION_EASE_OUT,
                              }
                            : { duration: 0 }
                        }
                      >
                        <RunHistory
                          routineId={routine.id}
                          profileNames={profileNames}
                        />
                      </motion.div>
                    )}
                  </motion.div>
                );
              })}
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
