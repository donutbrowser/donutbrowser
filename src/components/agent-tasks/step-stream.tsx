"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
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

function StepRow({ step, animate }: { step: AgentStep; animate: boolean }) {
  const { t } = useTranslation();
  const Icon = STEP_ICON[step.kind] ?? LuEye;
  const host = hostOf(step.url);
  return (
    <motion.li
      data-slot="agent-step"
      data-kind={step.kind}
      initial={animate ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={
        animate
          ? { duration: MOTION_DURATION.slow, ease: MOTION_EASE_OUT }
          : { duration: 0 }
      }
      className="flex gap-3 py-1.5"
    >
      <span
        className={cn(
          "mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg",
          step.kind === "act"
            ? "bg-primary/10 text-primary-text"
            : "bg-foreground/5 text-muted-foreground",
        )}
        title={t(`agent.tasks.stepKinds.${step.kind}`)}
      >
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p
          className={cn(
            "text-sm leading-relaxed break-words",
            step.kind === "think" ? "text-muted-foreground" : "text-foreground",
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
      className="flex flex-col gap-2.5 rounded-xl bg-warning/10 p-3"
    >
      <span className="text-xs font-medium text-warning-text">
        {t("agent.tasks.approvalTitle")}
      </span>
      <p className="text-sm break-words whitespace-pre-wrap text-foreground">
        {approval.question}
      </p>
      <div className="flex justify-end gap-2">
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
        className="rounded-xl bg-success/10 p-3 text-sm break-words whitespace-pre-wrap text-foreground"
      >
        {task.result}
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
        "rounded-xl p-3 text-sm break-words",
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
}: {
  batch: AgentBatch;
  task: AgentTask;
  profileName: string;
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
    endRef.current?.scrollIntoView({
      block: "end",
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

  return (
    <section
      data-slot="agent-step-stream"
      data-profile-id={task.profileId}
      aria-label={t("agent.tasks.streamLabel", { name: profileName })}
      className="flex min-h-0 flex-1 flex-col gap-3"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="truncate text-sm font-medium">{profileName}</span>
        <TaskStatusLabel status={task.status} />
        {task.creditsUsed > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("agent.tasks.credits", { n: format(task.creditsUsed) })}
          </span>
        )}
        {active && task.taskId && (
          <div className="ml-auto flex items-center gap-1">
            {task.status === "paused" ? (
              <Button
                type="button"
                variant="subtle"
                size="sm"
                disabled={busy !== null}
                data-slot="agent-task-resume"
                className="h-7 gap-1.5 rounded-lg text-xs"
                onClick={() => void control("resume")}
              >
                <LuPlay className="size-3.5" aria-hidden="true" />
                {t("agent.tasks.resume")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="subtle"
                size="sm"
                disabled={busy !== null || task.status === "needs_approval"}
                data-slot="agent-task-pause"
                className="h-7 gap-1.5 rounded-lg text-xs"
                onClick={() => void control("pause")}
              >
                <LuPause className="size-3.5" aria-hidden="true" />
                {t("agent.tasks.pause")}
              </Button>
            )}
            <Button
              type="button"
              variant="subtle"
              size="sm"
              disabled={busy !== null}
              data-slot="agent-task-stop"
              className="h-7 gap-1.5 rounded-lg text-xs hover:bg-destructive/10 hover:text-destructive-text"
              onClick={() => void control("stop")}
            >
              <LuSquare className="size-3 fill-current" aria-hidden="true" />
              {t("agent.tasks.stop")}
            </Button>
          </div>
        )}
      </header>

      <FadingScrollArea className="min-h-0 flex-1">
        <ol className="flex flex-col pr-1" aria-live="polite">
          {stepCount === 0 && active && (
            <li className="py-6 text-center text-xs text-muted-foreground">
              {task.status === "launching"
                ? t("agent.tasks.launching")
                : t("agent.tasks.waitingFirstStep")}
            </li>
          )}
          <AnimatePresence initial={false}>
            {steps.map((step) => (
              <StepRow key={step.index} step={step} animate={animate} />
            ))}
          </AnimatePresence>
        </ol>
        <div ref={endRef} />
      </FadingScrollArea>

      <ApprovalCard batch={batch} task={task} />
      <Outcome task={task} />

      {active && task.taskId && (
        <form
          className="flex shrink-0 items-center gap-2"
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
