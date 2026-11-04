"use client";

import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuPlus, LuTrash2 } from "react-icons/lu";
import { StateDot, useScheduleWords } from "@/components/agent-tasks/parts";
import { Button } from "@/components/ui/button";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import {
  type AgentChatSummary,
  chatAge,
  deleteAgentChat,
  isTurnActive,
} from "@/lib/agent-chat";
import {
  type AgentBatch,
  type AgentRoutine,
  type AgentRoutineDraft,
  batchStatus,
  promptTitle,
} from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";

/** What the main pane of the agent panel shows. */
export type PaneSelection =
  | { kind: "new" }
  | { kind: "chat"; id: string }
  | { kind: "run"; id: string }
  | { kind: "routine"; id: string }
  | { kind: "draft"; draft: AgentRoutineDraft; nonce: number };

const ITEM =
  "flex w-full min-w-0 flex-col gap-0.5 rounded-xl px-2.5 py-2 text-left transition-colors duration-150 motion-reduce:transition-none";

function itemTone(selected: boolean) {
  return selected ? "bg-foreground/7" : "hover:bg-foreground/4";
}

function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  return now;
}

function Age({ at, now }: { at: number; now: number }) {
  const { t, i18n } = useTranslation();
  const age = chatAge(at, now, i18n.language);
  return (
    <span className="shrink-0 tabular-nums">
      {age.kind === "now" ? t("agent.chat.justNow") : age.text}
    </span>
  );
}

function ChatListItem({
  chat,
  selected,
  profileName,
  now,
  onSelect,
  onDeleted,
}: {
  chat: AgentChatSummary;
  selected: boolean;
  profileName: string;
  now: number;
  onSelect: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => {
      setConfirming(false);
    }, 3000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [confirming]);

  const remove = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    try {
      await deleteAgentChat(chat.id);
      onDeleted();
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    }
  };

  const live = chat.status !== null && isTurnActive({ status: chat.status });
  return (
    <li className="group/chat relative">
      <button
        type="button"
        data-slot="chat-list-item"
        data-chat-id={chat.id}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(ITEM, "pr-8", itemTone(selected))}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {live && chat.status && <StateDot status={chat.status} />}
          <span className="truncate text-sm">{chat.title}</span>
        </span>
        <span className="flex min-w-0 gap-1 text-[11px] text-muted-foreground">
          <span className="truncate">{profileName}</span>
          <span aria-hidden="true">·</span>
          <Age at={chat.updatedAt} now={now} />
        </span>
      </button>
      <Button
        type="button"
        variant="subtle"
        size="sm"
        data-slot="chat-delete"
        aria-label={
          confirming ? t("agent.chat.confirmDelete") : t("agent.chat.delete")
        }
        title={
          confirming ? t("agent.chat.confirmDelete") : t("agent.chat.delete")
        }
        onClick={() => void remove()}
        className={cn(
          "absolute top-1.5 right-1 size-7 rounded-lg p-0 opacity-0 group-hover/chat:opacity-100 focus-visible:opacity-100",
          confirming &&
            "bg-destructive/10 text-destructive-text opacity-100 hover:bg-destructive/15",
        )}
      >
        <LuTrash2 className="size-3.5" aria-hidden="true" />
      </Button>
    </li>
  );
}

function RunListItem({
  batch,
  selected,
  now,
  onSelect,
}: {
  batch: AgentBatch;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const { tally } = batch;
  return (
    <li>
      <button
        type="button"
        data-slot="agent-run-item"
        data-batch-id={batch.id}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(ITEM, itemTone(selected))}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <StateDot status={batchStatus(batch)} />
          <span className="truncate text-sm">{promptTitle(batch.prompt)}</span>
        </span>
        <span className="flex min-w-0 gap-1 text-[11px] text-muted-foreground">
          <span className="truncate tabular-nums">
            {t("agent.tasks.progress", {
              done: tally.done + tally.failed + tally.stopped,
              total: batch.tasks.length,
            })}
          </span>
          <span aria-hidden="true">·</span>
          <Age at={batch.createdAt} now={now} />
        </span>
      </button>
    </li>
  );
}

function RoutineListItem({
  routine,
  selected,
  onSelect,
}: {
  routine: AgentRoutine;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const scheduleWords = useScheduleWords();
  return (
    <li>
      <button
        type="button"
        data-slot="agent-routine-item"
        data-routine-id={routine.id}
        data-enabled={routine.enabled ? "true" : "false"}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(ITEM, itemTone(selected))}
      >
        <span
          className={cn(
            "truncate text-sm",
            !routine.enabled && "text-muted-foreground",
          )}
        >
          {routine.name}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          {routine.enabled
            ? scheduleWords(routine.schedule)
            : t("agent.chat.routineOff")}
        </span>
      </button>
    </li>
  );
}

function Section({
  label,
  shown,
  children,
}: {
  label: string;
  shown: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      {shown && (
        <span className="px-2.5 pt-3 pb-1 text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
      )}
      <ul aria-label={label} className="flex flex-col gap-0.5">
        {children}
      </ul>
    </div>
  );
}

/** Chats, runs and routines, newest first, with a way to start anew. */
export function ChatSidebar({
  chats,
  batches,
  routines,
  selected,
  profileNames,
  onSelect,
}: {
  chats: AgentChatSummary[];
  batches: AgentBatch[];
  routines: AgentRoutine[];
  selected: PaneSelection;
  profileNames: Map<string, string>;
  onSelect: (selection: PaneSelection) => void;
}) {
  const { t } = useTranslation();
  const now = useMinuteClock();
  const is = (kind: PaneSelection["kind"], id: string) =>
    selected.kind === kind && "id" in selected && selected.id === id;
  // Labels show only once there is more than chats to tell apart.
  const labelled = batches.length > 0 || routines.length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <Button
        type="button"
        variant="subtle"
        size="sm"
        data-slot="chat-new"
        onClick={() => {
          onSelect({ kind: "new" });
        }}
        className={cn(
          "h-8 shrink-0 justify-start gap-2 rounded-xl px-2.5 text-xs",
          selected.kind === "new" && "bg-foreground/7",
        )}
      >
        <LuPlus className="size-3.5" aria-hidden="true" />
        {t("agent.chat.newChat")}
      </Button>
      <FadingScrollArea className="-mx-1 min-h-0 flex-1 px-1">
        <div data-slot="chat-list" className="flex flex-col">
          {chats.length > 0 && (
            <Section label={t("agent.chat.chats")} shown={labelled}>
              {chats.map((chat) => (
                <ChatListItem
                  key={chat.id}
                  chat={chat}
                  selected={is("chat", chat.id)}
                  profileName={
                    profileNames.get(chat.profileId) ??
                    t("agent.tasks.unknownProfile")
                  }
                  now={now}
                  onSelect={() => {
                    onSelect({ kind: "chat", id: chat.id });
                  }}
                  onDeleted={() => {
                    if (is("chat", chat.id)) onSelect({ kind: "new" });
                  }}
                />
              ))}
            </Section>
          )}
          {batches.length > 0 && (
            <Section label={t("agent.chat.runs")} shown>
              {batches.map((batch) => (
                <RunListItem
                  key={batch.id}
                  batch={batch}
                  selected={is("run", batch.id)}
                  now={now}
                  onSelect={() => {
                    onSelect({ kind: "run", id: batch.id });
                  }}
                />
              ))}
            </Section>
          )}
          {routines.length > 0 && (
            <Section label={t("agent.chat.routines")} shown>
              {routines.map((routine) => (
                <RoutineListItem
                  key={routine.id}
                  routine={routine}
                  selected={is("routine", routine.id)}
                  onSelect={() => {
                    onSelect({ kind: "routine", id: routine.id });
                  }}
                />
              ))}
            </Section>
          )}
        </div>
      </FadingScrollArea>
    </div>
  );
}
