"use client";

import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuCheck,
  LuChevronRight,
  LuPause,
  LuRotateCcw,
  LuSquare,
  LuX,
} from "react-icons/lu";
import { ChatMarkdown } from "@/components/agent-chat/markdown";
import { CreditsMeter, useNumber } from "@/components/agent-tasks/parts";
import { StepRow } from "@/components/agent-tasks/step-stream";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import {
  answerAgentChatApproval,
  type ChatTurn,
  isTurnActive,
} from "@/lib/agent-chat";
import { type AgentCredits, isTaskMoving } from "@/lib/agent-tasks";
import { parseBackendError, translateBackendError } from "@/lib/backend-errors";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";

function UserMessage({ text, steer }: { text: string; steer?: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      data-slot={steer ? "chat-steer" : "chat-user"}
      className="flex flex-col items-end gap-0.5"
    >
      <p
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-6 break-words whitespace-pre-wrap",
          steer
            ? "bg-foreground/5 text-foreground"
            : "bg-primary/10 text-foreground",
        )}
      >
        {text}
      </p>
      {steer && (
        <span className="px-1 text-[11px] text-muted-foreground">
          {t("agent.chat.steer")}
        </span>
      )}
    </div>
  );
}

/** The mark at the head of the work line: what the turn is doing now. */
function WorkMark({ turn }: { turn: ChatTurn }) {
  if (isTaskMoving(turn.status)) {
    return (
      <span className="grid size-4 place-items-center" aria-hidden="true">
        <span className="size-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
      </span>
    );
  }
  const icon =
    turn.status === "paused" ? (
      <LuPause className="size-3" />
    ) : turn.status === "needs_approval" ? (
      <span className="size-2 rounded-full bg-warning" />
    ) : turn.status === "done" ? (
      <LuCheck className="size-3.5 text-success" />
    ) : turn.status === "stopped" ? (
      <LuSquare className="size-2.5 fill-current" />
    ) : (
      <LuX className="size-3.5 text-destructive" />
    );
  return (
    <span
      className="grid size-4 place-items-center text-muted-foreground"
      aria-hidden="true"
    >
      {icon}
    </span>
  );
}

/** The agent's work on one turn: one line, and every step on demand. */
function WorkGroup({ turn }: { turn: ChatTurn }) {
  const { t } = useTranslation();
  const format = useNumber();
  const animate = useMotionAllowed();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const active = isTurnActive(turn);
  const moving = isTaskMoving(turn.status);
  const last = turn.steps.at(-1);
  const count = turn.steps.length;

  const headline = active
    ? turn.status === "paused"
      ? t("agent.tasks.status.paused")
      : turn.status === "needs_approval"
        ? t("agent.tasks.needsYou")
        : (last?.text ??
          (turn.status === "launching"
            ? t("agent.tasks.launching")
            : t("agent.tasks.waitingFirstStep")))
    : count > 0
      ? t("agent.chat.worked", { count })
      : t(`agent.tasks.status.${turn.status}`);

  const meta = [
    active && count > 0 ? t("agent.tasks.stepCount", { count }) : null,
    turn.creditsUsed > 0
      ? t("agent.tasks.credits", { n: format(turn.creditsUsed) })
      : null,
  ].filter(Boolean);

  return (
    <div
      data-slot="chat-work"
      data-status={turn.status}
      className="flex flex-col"
    >
      <button
        type="button"
        disabled={count === 0}
        aria-expanded={open}
        aria-controls={listId}
        data-slot="chat-work-toggle"
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="group/work -mx-2 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-foreground/4 disabled:hover:bg-transparent motion-reduce:transition-none"
      >
        <WorkMark turn={turn} />
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={active ? (last?.index ?? turn.status) : "settled"}
            data-slot="chat-work-headline"
            initial={animate ? { opacity: 0, y: 4 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={animate ? { opacity: 0, y: -4 } : { opacity: 0 }}
            transition={{
              duration: animate ? MOTION_DURATION.base : 0,
              ease: MOTION_EASE_OUT,
            }}
            className={cn(
              "min-w-0 flex-1 truncate",
              moving ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {headline}
          </motion.span>
        </AnimatePresence>
        {meta.length > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {meta.join(" · ")}
          </span>
        )}
        {count > 0 && (
          <LuChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={listId}
            key="steps"
            initial={animate ? { height: 0, opacity: 0 } : false}
            animate={{ height: "auto", opacity: 1 }}
            exit={animate ? { height: 0, opacity: 0 } : { opacity: 0 }}
            transition={{
              duration: animate ? MOTION_DURATION.base : 0,
              ease: MOTION_EASE_OUT,
            }}
            className="overflow-hidden"
          >
            <ol
              data-slot="chat-steps"
              aria-label={t("agent.chat.steps")}
              className="ml-0.5 flex flex-col pt-1 pb-1"
            >
              {turn.steps.map((step, index) => (
                <StepRow
                  key={step.index}
                  step={step}
                  current={moving && index === count - 1}
                  animate={animate}
                />
              ))}
            </ol>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Approval({ chatId, turn }: { chatId: string; turn: ChatTurn }) {
  const { t } = useTranslation();
  const replyId = useId();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const approval = turn.approval;
  if (!approval) return null;
  const answer = async (approve: boolean) => {
    setBusy(true);
    try {
      await answerAgentChatApproval(
        chatId,
        approval.approvalId,
        approve,
        reply.trim() || undefined,
      );
      setReply("");
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      data-slot="chat-approval"
      aria-label={t("agent.tasks.approvalTitle")}
      className="flex flex-col gap-2.5 rounded-2xl bg-warning/10 p-3"
    >
      <span className="flex items-center gap-2 text-xs font-medium text-warning-text">
        <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
        {t("agent.tasks.approvalTitle")}
      </span>
      <p className="text-sm leading-6 break-words whitespace-pre-wrap">
        {approval.question}
      </p>
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void answer(true);
        }}
      >
        <label htmlFor={replyId} className="sr-only">
          {t("agent.chat.replyLabel")}
        </label>
        <Input
          id={replyId}
          variant="soft"
          value={reply}
          maxLength={2000}
          placeholder={t("agent.chat.replyPlaceholder")}
          data-slot="chat-approval-reply"
          className="h-8 min-w-40 flex-1 bg-background/60 text-xs md:text-xs"
          onChange={(event) => {
            setReply(event.target.value);
          }}
        />
        <Button
          type="button"
          variant="subtle"
          size="sm"
          disabled={busy}
          data-slot="chat-approval-decline"
          className="h-8 rounded-lg text-xs"
          onClick={() => void answer(false)}
        >
          {t("agent.tasks.decline")}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={busy}
          data-slot="chat-approval-approve"
          className="h-8 rounded-lg text-xs"
        >
          {t("agent.tasks.approve")}
        </Button>
      </form>
    </section>
  );
}

function errorCode(error: string | null): string | null {
  return error ? (parseBackendError(error)?.code ?? null) : null;
}

/** How the turn ended: the answer, or why there is none. */
function Outcome({
  turn,
  credits,
  onOpenAccount,
}: {
  turn: ChatTurn;
  credits: AgentCredits | null;
  onOpenAccount: () => void;
}) {
  const { t } = useTranslation();
  if (isTurnActive(turn)) return null;
  if (turn.status === "done" && turn.result) {
    return (
      <div data-slot="chat-answer">
        <ChatMarkdown text={turn.result} />
      </div>
    );
  }
  const code = errorCode(turn.error);
  if (turn.status === "no_credits" || code === "NO_CREDITS") {
    return (
      <div
        data-slot="chat-no-credits"
        className="flex flex-col gap-2 rounded-2xl bg-warning/10 p-3"
      >
        <span className="text-sm font-medium text-warning-text">
          {t("agent.chat.noCreditsTitle")}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("agent.chat.noCreditsBody")}
        </span>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CreditsMeter credits={credits} />
          <Button
            type="button"
            size="sm"
            variant="soft"
            className="h-8 rounded-lg text-xs"
            onClick={onOpenAccount}
          >
            {t("agent.setup.planAction")}
          </Button>
        </div>
      </div>
    );
  }
  const reason =
    turn.status === "budget" || code === "TASK_BUDGET"
      ? t("agent.tasks.endedBudget")
      : turn.error
        ? code
          ? translateBackendError(t, turn.error)
          : turn.error
        : null;
  if (!reason) return null;
  return (
    <p
      data-slot="chat-failure"
      className={cn(
        "text-sm break-words",
        turn.status === "failed"
          ? "text-destructive-text"
          : "text-warning-text",
      )}
    >
      {reason}
    </p>
  );
}

/** One message, the agent's work on it, and what came of it. */
export function ChatTurnView({
  chatId,
  turn,
  credits,
  onOpenAccount,
}: {
  chatId: string;
  turn: ChatTurn;
  credits: AgentCredits | null;
  onOpenAccount: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li
      data-slot="chat-turn"
      data-turn-id={turn.id}
      data-kind={turn.kind}
      data-status={turn.status}
      className="flex flex-col gap-2"
    >
      <UserMessage text={turn.text} />
      {turn.steers.map((steer) => (
        <UserMessage key={steer.at} text={steer.text} steer />
      ))}
      {turn.kind === "fresh" && (
        <p
          data-slot="chat-fresh"
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <LuRotateCcw className="size-3 shrink-0" aria-hidden="true" />
          {t("agent.chat.fresh")}
        </p>
      )}
      <WorkGroup turn={turn} />
      <Approval chatId={chatId} turn={turn} />
      <Outcome turn={turn} credits={credits} onOpenAccount={onOpenAccount} />
    </li>
  );
}
