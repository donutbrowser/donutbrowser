"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowLeft, LuRepeat } from "react-icons/lu";
import { LiveView } from "@/components/agent-chat/live-view";
import { SidebarToggle } from "@/components/agent-shell";
import { PaneHeader, statusLabelKey } from "@/components/agent-tasks/parts";
import { RunView } from "@/components/agent-tasks/run-view";
import { StepStream } from "@/components/agent-tasks/step-stream";
import { Button } from "@/components/ui/button";
import { useProfilePreviews } from "@/hooks/use-profile-previews";
import { type AgentBatch, isTaskActive, promptTitle } from "@/lib/agent-tasks";

const MAX_LIVE_TILES = 12;

/**
 * A run in the main pane: a live tile for every profile, the one that needs
 * the person first. A tile opens that profile's steps beside its window.
 */
export function RunPane({
  batch,
  nameOf,
  onSaveRoutine,
  onDismissed,
}: {
  batch: AgentBatch;
  nameOf: (profileId: string) => string;
  onSaveRoutine: () => void;
  onDismissed: (batchId: string) => void;
}) {
  const { t } = useTranslation();
  const [openId, setOpenId] = useState<string | null>(null);
  const task = openId
    ? batch.tasks.find((item) => item.profileId === openId)
    : undefined;
  // Pictures cost a capture each: the open profile, or the first few at work.
  const watched = useMemo(() => {
    const working = batch.tasks
      .filter((item) => isTaskActive(item.status) && item.taskId)
      .map((item) => item.profileId);
    return openId
      ? working.filter((id) => id === openId)
      : working.slice(0, MAX_LIVE_TILES);
  }, [batch.tasks, openId]);
  const images = useProfilePreviews(watched, watched.length > 0);
  const live =
    task && isTaskActive(task.status)
      ? {
          profileId: task.profileId,
          profileName: nameOf(task.profileId),
          status: task.status,
          step:
            task.status === "needs_approval"
              ? t("agent.tasks.needsYou")
              : (task.lastStep?.text ?? t(statusLabelKey(task.status))),
          url: task.lastStep?.url ?? null,
          image: images[task.profileId],
        }
      : null;

  return (
    <section
      data-slot="agent-run-pane"
      data-batch-id={batch.id}
      className="@container flex min-h-0 min-w-0 flex-1 flex-col gap-3"
    >
      <PaneHeader lead={<SidebarToggle />} title={promptTitle(batch.prompt)}>
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
      {task ? (
        <div className="flex min-h-0 flex-1 gap-5">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <StepStream
              key={`${batch.id}:${task.profileId}`}
              batch={batch}
              task={task}
              profileName={nameOf(task.profileId)}
              media={
                live && (
                  <div className="shrink-0 @[52rem]:hidden">
                    <LiveView layout="strip" {...live} />
                  </div>
                )
              }
              lead={
                <Button
                  type="button"
                  variant="subtle"
                  size="sm"
                  data-slot="agent-run-back"
                  aria-label={t("agent.tasks.allProfilesBack")}
                  title={t("agent.tasks.allProfilesBack")}
                  className="size-8 shrink-0 rounded-xl p-0"
                  onClick={() => {
                    setOpenId(null);
                  }}
                >
                  <LuArrowLeft className="size-4" aria-hidden="true" />
                </Button>
              }
            />
          </div>
          {live && (
            <div className="hidden w-[min(28rem,44%)] shrink-0 flex-col @[52rem]:flex">
              <LiveView layout="panel" {...live} />
            </div>
          )}
        </div>
      ) : (
        <RunView
          batch={batch}
          nameOf={nameOf}
          images={images}
          onOpen={setOpenId}
          onDismissed={onDismissed}
        />
      )}
    </section>
  );
}
