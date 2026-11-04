"use client";

import { type ReactNode, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuChevronRight,
  LuEllipsis,
  LuPencil,
  LuPlay,
  LuTrash2,
} from "react-icons/lu";
import { useTimeFormat } from "@/components/agent-console-parts";
import {
  PaneHeader,
  StateDot,
  statusLabelKey,
  useNumber,
  useScheduleWords,
} from "@/components/agent-tasks/parts";
import { RoutineEditor } from "@/components/agent-tasks/routine-editor";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { AnimatedSwitch } from "@/components/ui/animated-switch";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AgentBatch,
  type AgentRoutine,
  type AgentRoutineBatch,
  type AgentRoutineRun,
  deleteAgentRoutine,
  groupRoutineRuns,
  hostOf,
  listAgentRoutineRuns,
  runAgentRoutine,
  stateCounts,
  TASK_STATES,
  updateAgentRoutine,
} from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { BrowserProfile, GroupWithCount } from "@/types";

/** Dots shown before the rest is a count. */
const MAX_DOTS = 24;
/** Batches the history lists. */
const MAX_BATCHES = 20;

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

/** "Done 3 Failed 1", from the states that occurred. */
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
      {batches.slice(0, MAX_BATCHES).map((batch) => {
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

/** A routine in the main pane: what it does, where, when, and its runs. */
export function RoutineView({
  routine,
  lead,
  profiles,
  groups,
  canSchedule,
  onUpgrade,
  finishedRuns,
  onSaved,
  onRan,
  onDeleted,
}: {
  routine: AgentRoutine;
  lead: ReactNode;
  profiles: BrowserProfile[];
  groups: GroupWithCount[];
  canSchedule: boolean;
  onUpgrade: () => void;
  /** Moves when a run finishes, so the history is read again. */
  finishedRuns: number;
  onSaved: (routine: AgentRoutine) => void;
  onRan: (batch: AgentBatch) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const switchId = useId();
  const scheduleWords = useScheduleWords();
  const { batches, error } = useRoutineRuns(routine.id, finishedRuns);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const profileNames = new Map(profiles.map((p) => [p.id, p.name]));
  const host = hostOf(routine.startUrl);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (actError) {
      showErrorToast(translateBackendError(t, actError));
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = (enabled: boolean) =>
    act(async () => {
      const { id: _id, createdAt: _c, updatedAt: _u, ...draft } = routine;
      onSaved(await updateAgentRoutine(routine.id, { ...draft, enabled }));
    });

  return (
    <section
      data-slot="agent-routine"
      data-routine-id={routine.id}
      data-enabled={routine.enabled ? "true" : "false"}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
    >
      <PaneHeader lead={lead} title={routine.name}>
        {!editing && (
          <>
            <div className="flex items-center gap-2 px-1">
              <AnimatedSwitch
                id={switchId}
                checked={routine.enabled}
                disabled={busy}
                data-slot="agent-routine-enabled"
                onCheckedChange={(checked) => void setEnabled(checked)}
              />
              <Label htmlFor={switchId} className="text-xs">
                {t("agent.chat.routineOn")}
              </Label>
            </div>
            <Button
              variant="soft"
              size="sm"
              data-slot="agent-routine-run-now"
              className="h-8 gap-1.5 rounded-lg text-xs"
              disabled={busy || routine.profileIds.length === 0}
              aria-busy={busy}
              aria-label={t("agent.routines.runAria", { name: routine.name })}
              onClick={() =>
                void act(async () => {
                  onRan(await runAgentRoutine(routine.id));
                })
              }
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
                  aria-label={t("agent.routines.menuAria", {
                    name: routine.name,
                  })}
                  className="size-8 rounded-lg p-0"
                >
                  <LuEllipsis className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem
                  data-slot="agent-routine-edit"
                  onSelect={() => {
                    setEditing(true);
                  }}
                >
                  <LuPencil aria-hidden="true" />
                  {t("common.buttons.edit")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-slot="agent-routine-delete"
                  variant="destructive"
                  onSelect={() => {
                    setRemoving(true);
                  }}
                >
                  <LuTrash2 aria-hidden="true" />
                  {t("common.buttons.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </PaneHeader>

      <FadingScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 py-1">
          {editing ? (
            <RoutineEditor
              id={routine.id}
              initial={routine}
              profiles={profiles}
              groups={groups}
              canSchedule={canSchedule}
              onUpgrade={onUpgrade}
              onCancel={() => {
                setEditing(false);
              }}
              onSaved={(saved) => {
                setEditing(false);
                onSaved(saved);
              }}
            />
          ) : (
            <div className="flex flex-col gap-2">
              <p
                data-slot="agent-routine-prompt-text"
                className="text-sm leading-6 break-words whitespace-pre-wrap"
              >
                {routine.prompt}
              </p>
              <p
                data-slot="agent-routine-meta"
                className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground"
              >
                <span>
                  {t("agent.tasks.profileCount", {
                    count: routine.profileIds.length,
                  })}
                </span>
                <span aria-hidden="true">·</span>
                <span>{scheduleWords(routine.schedule)}</span>
                {host && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{host}</span>
                  </>
                )}
              </p>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <span className="px-2 text-xs font-medium text-muted-foreground">
              {t("agent.routines.history")}
            </span>
            <RunHistory
              batches={batches}
              error={error}
              profileNames={profileNames}
            />
          </div>
        </div>
      </FadingScrollArea>

      <DeleteConfirmationDialog
        isOpen={removing}
        onClose={() => {
          setRemoving(false);
        }}
        onConfirm={() =>
          act(async () => {
            await deleteAgentRoutine(routine.id);
            setRemoving(false);
            onDeleted();
          })
        }
        title={t("agent.routines.deleteTitle", { name: routine.name })}
        description={t("agent.routines.deleteDescription")}
        confirmButtonText={t("common.buttons.delete")}
        isLoading={busy}
      />
    </section>
  );
}
