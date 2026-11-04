"use client";

import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuEye,
  LuLightbulb,
  LuMousePointerClick,
  LuPause,
  LuPlay,
  LuSend,
  LuSquare,
} from "react-icons/lu";
import { ChatMarkdown } from "@/components/agent-chat/markdown";
import { TaskStatusLabel, useNumber } from "@/components/agent-tasks/parts";
import { Button } from "@/components/ui/button";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTaskSteps } from "@/hooks/use-agent-tasks";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import {
  type AgentBatch,
  type AgentControl,
  type AgentStep,
  type AgentTask,
  answerAgentApproval,
  controlAgentTask,
  hostOf,
  isTaskActive,
  isTaskMoving,
} from "@/lib/agent-tasks";
import { parseBackendError, translateBackendError } from "@/lib/backend-errors";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";

const STEP_ICON = {
  think: LuLightbulb,
  act: LuMousePointerClick,
  observe: LuEye,
} as const;

export function StepRow({
  step,
  current,
  animate,
}: {
  step: AgentStep;
  current: boolean;
  animate: boolean;
}) {
  const { t } = useTranslation();
  const Icon = STEP_ICON[step.kind] ?? LuEye;
  const host = hostOf(step.url);
  return (
    <motion.li
      data-slot="agent-step"
      data-kind={step.kind}
      data-current={current ? "true" : undefined}
      initial={animate ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={
        animate
          ? { duration: MOTION_DURATION.slow, ease: MOTION_EASE_OUT }
          : { duration: 0 }
      }
      className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 py-1.5"
    >
      <span
        className="grid h-5 place-items-center"
        title={t(`agent.tasks.stepKinds.${step.kind}`)}
      >
        {current ? (
          <span
            aria-hidden="true"
            className="size-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
          />
        ) : (
          <Icon
            className={cn(
              "size-3.5",
              step.kind === "act" ? "text-foreground" : "text-muted-foreground",
            )}
            aria-hidden="true"
          />
        )}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p
          className={cn(
            "text-sm leading-5 break-words transition-colors duration-300 motion-reduce:transition-none",
            current || step.kind === "act"
              ? "text-foreground"
              : "text-muted-foreground",
          )}
        >
          {step.text}
        </p>
        {(host || step.tool) && (
          <span className="truncate text-[11px] text-muted-foreground">
            {[step.tool, host].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>
    </motion.li>
  );
}

function ApprovalCard({ batch, task }: { batch: AgentBatch; task: AgentTask }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const approval = task.approval;
  if (!approval) return null;
  const answer = async (approve: boolean) => {
    setBusy(true);
    try {
      await answerAgentApproval(
        batch.id,
        task.profileId,
        approval.approvalId,
        approve,
      );
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      data-slot="agent-approval"
      aria-label={t("agent.tasks.approvalTitle")}
      className="flex shrink-0 flex-col gap-2 rounded-xl bg-warning/10 p-3"
    >
      <span className="flex items-center gap-2 text-xs font-medium text-warning-text">
        <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
        {t("agent.tasks.approvalTitle")}
      </span>
      <p className="pl-4 text-sm break-words whitespace-pre-wrap text-foreground">
        {approval.question}
      </p>
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          variant="subtle"
          size="sm"
          disabled={busy}
          data-slot="agent-approval-decline"
          className="h-8 rounded-lg text-xs"
          onClick={() => void answer(false)}
        >
          {t("agent.tasks.decline")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          data-slot="agent-approval-approve"
          className="h-8 rounded-lg text-xs"
          onClick={() => void answer(true)}
        >
          {t("agent.tasks.approve")}
        </Button>
      </div>
    </section>
  );
}

/** What the task ended with: its answer, or why it stopped. */
function Outcome({ task }: { task: AgentTask }) {
  const { t } = useTranslation();
  if (task.status === "done" && task.result) {
    return (
      <div
        data-slot="agent-result"
        className="max-h-40 shrink-0 overflow-y-auto rounded-xl bg-success/10 p-3 text-foreground"
      >
        <ChatMarkdown text={task.result} />
      </div>
    );
  }
  const reason =
    task.status === "no_credits"
      ? t("agent.tasks.endedNoCredits")
      : task.status === "budget"
        ? t("agent.tasks.endedBudget")
        : task.error
          ? parseBackendError(task.error)
            ? translateBackendError(t, task.error)
            : task.error
          : null;
  if (!reason) return null;
  return (
    <div
      data-slot="agent-failure"
      className={cn(
        "shrink-0 rounded-xl p-3 text-sm break-words",
        task.status === "failed"
          ? "bg-destructive/10 text-destructive-text"
          : "bg-warning/10 text-warning-text",
      )}
    >
      {reason}
    </div>
  );
}

/** One task, live: its steps, an open question, the controls and a steer. */
export function StepStream({
  batch,
  task,
  profileName,
  lead,
  media,
}: {
  batch: AgentBatch;
  task: AgentTask;
  profileName: string;
  /** A control before the name, such as the way back to the run. */
  lead?: ReactNode;
  /** Shown under the header, such as the profile's live window. */
  media?: ReactNode;
}) {
  const { t } = useTranslation();
  const format = useNumber();
  const animate = useMotionAllowed();
  const steerId = useId();
  const steps = useTaskSteps(batch.id, task.profileId, task.taskId);
  const [steer, setSteer] = useState("");
  const [busy, setBusy] = useState<AgentControl | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const active = isTaskActive(task.status);
  const stepCount = steps.length;

  useEffect(() => {
    if (stepCount === 0) return;
    // Only the list scrolls; scrollIntoView would move the page too.
    const box = endRef.current?.parentElement;
    box?.scrollTo({
      top: box.scrollHeight,
      behavior: animate ? "smooth" : "auto",
    });
  }, [stepCount, animate]);

  const control = async (action: AgentControl, message?: string) => {
    setBusy(action);
    try {
      await controlAgentTask(batch.id, task.profileId, action, message);
      if (action === "steer") setSteer("");
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setBusy(null);
    }
  };

  const moving = isTaskMoving(task.status);
  return (
    <section
      data-slot="agent-step-stream"
      data-profile-id={task.profileId}
      aria-label={t("agent.tasks.streamLabel", { name: profileName })}
      className="flex min-h-0 flex-1 flex-col gap-3"
    >
      <header className="flex shrink-0 items-start gap-3">
        {lead}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{profileName}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-xs tabular-nums text-muted-foreground">
            <TaskStatusLabel status={task.status} />
            {stepCount > 0 && (
              <span>{t("agent.tasks.stepCount", { count: stepCount })}</span>
            )}
            {task.creditsUsed > 0 && (
              <span>
                {t("agent.tasks.credits", { n: format(task.creditsUsed) })}
              </span>
            )}
          </span>
        </div>
        {active && task.taskId && (
          <div className="flex shrink-0 items-center gap-0.5">
            {task.status === "paused" ? (
              <Button
                type="button"
                variant="subtle"
                size="sm"
                disabled={busy !== null}
                data-slot="agent-task-resume"
                aria-label={t("agent.tasks.resume")}
                title={t("agent.tasks.resume")}
                className="size-7 rounded-lg p-0"
                onClick={() => void control("resume")}
              >
                <LuPlay className="size-3.5" aria-hidden="true" />
              </Button>
            ) : (
              <Button
                type="button"
                variant="subtle"
                size="sm"
                disabled={busy !== null || task.status === "needs_approval"}
                data-slot="agent-task-pause"
                aria-label={t("agent.tasks.pause")}
                title={t("agent.tasks.pause")}
                className="size-7 rounded-lg p-0"
                onClick={() => void control("pause")}
              >
                <LuPause className="size-3.5" aria-hidden="true" />
              </Button>
            )}
            <Button
              type="button"
              variant="subtle"
              size="sm"
              disabled={busy !== null}
              data-slot="agent-task-stop"
              aria-label={t("agent.tasks.stop")}
              title={t("agent.tasks.stop")}
              className="size-7 rounded-lg p-0 hover:bg-destructive/10 hover:text-destructive-text"
              onClick={() => void control("stop")}
            >
              <LuSquare className="size-3 fill-current" aria-hidden="true" />
            </Button>
          </div>
        )}
      </header>
      {media}

      <FadingScrollArea className="-mx-1 min-h-0 flex-1 px-1">
        <ol className="flex flex-col" aria-live="polite">
          {stepCount === 0 && active && (
            <li className="flex items-center gap-3 py-1.5 text-sm text-muted-foreground">
              <span className="grid h-5 w-4 place-items-center">
                <span
                  aria-hidden="true"
                  className="size-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
                />
              </span>
              {task.status === "launching"
                ? t("agent.tasks.launching")
                : t("agent.tasks.waitingFirstStep")}
            </li>
          )}
          <AnimatePresence initial={false}>
            {steps.map((step, index) => (
              <StepRow
                key={step.index}
                step={step}
                current={moving && index === stepCount - 1}
                animate={animate}
              />
            ))}
          </AnimatePresence>
        </ol>
        <div ref={endRef} />
      </FadingScrollArea>

      <ApprovalCard batch={batch} task={task} />
      <Outcome task={task} />

      {active && task.taskId && (
        <form
          className="flex shrink-0 items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (steer.trim()) void control("steer", steer.trim());
          }}
        >
          <Label htmlFor={steerId} className="sr-only">
            {t("agent.tasks.steerLabel")}
          </Label>
          <Input
            id={steerId}
            variant="soft"
            value={steer}
            maxLength={2000}
            placeholder={t("agent.tasks.steerPlaceholder")}
            data-slot="agent-task-steer"
            className="h-8 text-xs md:text-xs"
            onChange={(event) => {
              setSteer(event.target.value);
            }}
          />
          <Button
            type="submit"
            variant="soft"
            size="sm"
            disabled={!steer.trim() || busy !== null}
            aria-label={t("agent.tasks.steerSend")}
            data-slot="agent-task-steer-send"
            className="h-8 rounded-lg px-2.5"
          >
            <LuSend className="size-3.5" />
          </Button>
        </form>
      )}
    </section>
  );
}
