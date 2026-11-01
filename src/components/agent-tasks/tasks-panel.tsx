"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuSparkles } from "react-icons/lu";
import { BatchCard } from "@/components/agent-tasks/batch-card";
import { StepStream } from "@/components/agent-tasks/step-stream";
import { TaskComposer } from "@/components/agent-tasks/task-composer";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import type { AgentBatch } from "@/lib/agent-tasks";
import type { BrowserProfile } from "@/types";

interface Selection {
  batchId: string;
  profileId: string;
}

/**
 * Tasks: write one, send it to the profiles it is for, and watch each one
 * work. The newest run is chosen unless the person picked another.
 */
export function AgentTasksPanel({
  profiles,
  batches,
  seedProfileIds,
  onBatchStarted,
  onBatchDismissed,
}: {
  profiles: BrowserProfile[];
  batches: AgentBatch[];
  seedProfileIds: string[] | null;
  onBatchStarted: (batch: AgentBatch) => void;
  onBatchDismissed: (batchId: string) => void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Selection | null>(null);

  const profileNames = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.name])),
    [profiles],
  );

  const selection = useMemo(() => {
    const batch =
      batches.find((item) => item.id === picked?.batchId) ?? batches[0];
    if (!batch) return null;
    const task =
      batch.tasks.find((item) => item.profileId === picked?.profileId) ??
      batch.tasks.find((item) => item.status === "needs_approval") ??
      batch.tasks.find((item) => item.status === "running") ??
      batch.tasks[0];
    return task ? { batch, task } : null;
  }, [batches, picked]);

  return (
    // On a short window the whole panel scrolls; on a tall one the run list
    // and the step stream fill it and scroll on their own.
    <FadingScrollArea
      data-slot="agent-tasks"
      className="@container flex min-h-0 flex-1 flex-col gap-4"
    >
      <TaskComposer
        profiles={profiles}
        seedProfileIds={seedProfileIds}
        onStarted={(batch) => {
          onBatchStarted(batch);
          setPicked({
            batchId: batch.id,
            profileId: batch.tasks[0]?.profileId ?? "",
          });
        }}
      />

      {batches.length === 0 ? (
        <div
          data-slot="agent-tasks-empty"
          className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center"
        >
          <span
            aria-hidden="true"
            className="grid size-10 place-items-center rounded-2xl bg-foreground/5 text-muted-foreground"
          >
            <LuSparkles className="size-4" />
          </span>
          <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
            {t("agent.tasks.empty")}
          </p>
        </div>
      ) : (
        <div className="flex min-h-[26rem] flex-1 flex-col gap-4 @3xl:flex-row">
          <FadingScrollArea className="min-h-0 @3xl:w-[min(26rem,45%)] @3xl:shrink-0">
            <div className="flex flex-col gap-5 pr-1">
              {batches.map((batch) => (
                <BatchCard
                  key={batch.id}
                  batch={batch}
                  profileNames={profileNames}
                  selectedProfileId={
                    selection?.batch.id === batch.id
                      ? selection.task.profileId
                      : null
                  }
                  onSelect={(profileId) => {
                    setPicked({ batchId: batch.id, profileId });
                  }}
                  onDismissed={(batchId) => {
                    if (picked?.batchId === batchId) setPicked(null);
                    onBatchDismissed(batchId);
                  }}
                />
              ))}
            </div>
          </FadingScrollArea>
          {selection && (
            <div className="flex min-h-80 min-w-0 flex-1 flex-col rounded-2xl bg-foreground/3 p-4">
              <StepStream
                key={`${selection.batch.id}:${selection.task.profileId}`}
                batch={selection.batch}
                task={selection.task}
                profileName={
                  profileNames.get(selection.task.profileId) ??
                  t("agent.tasks.unknownProfile")
                }
              />
            </div>
          )}
        </div>
      )}
    </FadingScrollArea>
  );
}
