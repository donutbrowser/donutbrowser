"use client";

import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuRepeat } from "react-icons/lu";
import { PaneHeader } from "@/components/agent-tasks/parts";
import { RunView } from "@/components/agent-tasks/run-view";
import { StepStream } from "@/components/agent-tasks/step-stream";
import { Button } from "@/components/ui/button";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { type AgentBatch, promptTitle } from "@/lib/agent-tasks";

/**
 * A run in the main pane: every profile, and the steps of the one open. The
 * one that needs the person opens first, then one that works.
 */
export function RunPane({
  batch,
  lead,
  nameOf,
  onSaveRoutine,
  onDismissed,
}: {
  batch: AgentBatch;
  lead: ReactNode;
  nameOf: (profileId: string) => string;
  onSaveRoutine: () => void;
  onDismissed: (batchId: string) => void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string | null>(null);
  const task = useMemo(
    () =>
      batch.tasks.find((item) => item.profileId === picked) ??
      batch.tasks.find((item) => item.status === "needs_approval") ??
      batch.tasks.find((item) => item.status === "running") ??
      batch.tasks[0],
    [batch.tasks, picked],
  );

  return (
    <section
      data-slot="agent-run-pane"
      data-batch-id={batch.id}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
    >
      <PaneHeader lead={lead} title={promptTitle(batch.prompt)}>
        {!batch.routineId && (
          <Button
            type="button"
            variant="subtle"
            size="sm"
            data-slot="agent-run-save-routine"
            className="h-8 gap-1.5 rounded-lg text-xs"
            onClick={onSaveRoutine}
          >
            <LuRepeat className="size-3.5" aria-hidden="true" />
            {t("agent.chat.saveAsRoutine")}
          </Button>
        )}
      </PaneHeader>
      {/* On a short window the pane scrolls; on a tall one the rows and the
          steps fill it and scroll on their own. */}
      <FadingScrollArea className="@container flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col gap-4 @3xl:min-h-64 @3xl:flex-row">
          <RunView
            batch={batch}
            nameOf={nameOf}
            openProfileId={task?.profileId ?? null}
            onOpen={setPicked}
            onDismissed={onDismissed}
          />
          {task && (
            <div className="flex min-h-80 min-w-0 flex-col rounded-2xl bg-foreground/3 p-4 @3xl:min-h-0 @3xl:w-[min(30rem,46%)] @3xl:shrink-0">
              <StepStream
                key={`${batch.id}:${task.profileId}`}
                batch={batch}
                task={task}
                profileName={nameOf(task.profileId)}
              />
            </div>
          )}
        </div>
      </FadingScrollArea>
    </section>
  );
}
