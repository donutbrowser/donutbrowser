"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuRotateCcw, LuSquare, LuX } from "react-icons/lu";
import { ProgressBar } from "@/components/agent-console-parts";
import { useNumber } from "@/components/agent-tasks/parts";
import { StatusDot } from "@/components/cookie-bot-shared";
import { Button } from "@/components/ui/button";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import {
  type AgentBatch,
  type AgentTask,
  batchProgress,
  dismissAgentBatch,
  promptTitle,
  retryAgentBatch,
  statusTone,
  stopAgentBatch,
} from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { MOTION_SPRING } from "@/lib/motion";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";

/** The one line a tile shows: the newest step, or what the status means. */
function statusLine(
  t: ReturnType<typeof useTranslation>["t"],
  task: AgentTask,
): string {
  if (task.status === "needs_approval") return t("agent.tasks.needsYou");
  if (task.status === "done" && task.result) return task.result;
  if (task.lastStep && task.status !== "queued") return task.lastStep.text;
  return t(`agent.tasks.status.${task.status}`);
}

function ProfileTile({
  task,
  name,
  selected,
  onSelect,
}: {
  task: AgentTask;
  name: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const format = useNumber();
  const live = task.status === "running" || task.status === "launching";
  return (
    <button
      type="button"
      data-slot="agent-batch-tile"
      data-profile-id={task.profileId}
      data-status={task.status}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        selected ? "bg-primary/10" : "bg-foreground/3 hover:bg-foreground/5",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot tone={statusTone(task.status)} pulse={live} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {name}
        </span>
        {task.creditsUsed > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {format(task.creditsUsed)}
          </span>
        )}
      </span>
      <span
        className={cn(
          "truncate text-xs",
          task.status === "needs_approval"
            ? "text-warning-text"
            : task.status === "failed"
              ? "text-destructive-text"
              : "text-muted-foreground",
        )}
      >
        {statusLine(t, task)}
      </span>
    </button>
  );
}

/** One run on one or many profiles: totals, the batch controls and a tile per profile. */
export function BatchCard({
  batch,
  profileNames,
  selectedProfileId,
  onSelect,
  onDismissed,
}: {
  batch: AgentBatch;
  profileNames: Map<string, string>;
  selectedProfileId: string | null;
  onSelect: (profileId: string) => void;
  onDismissed: (batchId: string) => void;
}) {
  const { t } = useTranslation();
  const format = useNumber();
  const animate = useMotionAllowed();
  const [busy, setBusy] = useState(false);
  const { tally } = batch;
  const total = batch.tasks.length;
  const ended = tally.done + tally.failed + tally.stopped;
  const nameOf = (profileId: string) =>
    profileNames.get(profileId) ?? t("agent.tasks.unknownProfile");

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
    <motion.article
      layout={animate ? "position" : false}
      initial={animate ? { opacity: 0.6, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={animate ? MOTION_SPRING.gentle : { duration: 0 }}
      data-slot="agent-batch"
      data-batch-id={batch.id}
      data-finished={batch.finished ? "true" : "false"}
      className="flex flex-col gap-2.5"
    >
      <header className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h4 className="truncate text-sm font-medium" title={batch.prompt}>
            {promptTitle(batch.prompt)}
          </h4>
          <p
            data-slot="agent-batch-summary"
            className="flex flex-wrap gap-x-2 text-xs text-muted-foreground tabular-nums"
          >
            <span>{t("agent.tasks.progress", { done: ended, total })}</span>
            {tally.failed > 0 && (
              <span className="text-destructive-text">
                {t("agent.tasks.failedCount", { n: tally.failed })}
              </span>
            )}
            {tally.creditsUsed > 0 && (
              <span>
                {t("agent.tasks.credits", { n: format(tally.creditsUsed) })}
              </span>
            )}
            {batch.routineId && <span>{t("agent.tasks.fromRoutine")}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!batch.finished && (
            <Button
              type="button"
              variant="subtle"
              size="sm"
              disabled={busy || batch.stopping}
              data-slot="agent-batch-stop"
              className="h-7 gap-1.5 rounded-lg text-xs hover:bg-destructive/10 hover:text-destructive-text"
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
              className="h-7 gap-1.5 rounded-lg text-xs"
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
        <>
          <ProgressBar
            percent={batchProgress(tally, total)}
            label={t("agent.tasks.progress", { done: ended, total })}
          />
          <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(12.5rem,1fr))]">
            {batch.tasks.map((task) => (
              <ProfileTile
                key={task.profileId}
                task={task}
                name={nameOf(task.profileId)}
                selected={task.profileId === selectedProfileId}
                onSelect={() => {
                  onSelect(task.profileId);
                }}
              />
            ))}
          </div>
        </>
      )}
      {total === 1 && (
        <ProfileTile
          task={batch.tasks[0]}
          name={nameOf(batch.tasks[0].profileId)}
          selected={batch.tasks[0].profileId === selectedProfileId}
          onSelect={() => {
            onSelect(batch.tasks[0].profileId);
          }}
        />
      )}
    </motion.article>
  );
}
