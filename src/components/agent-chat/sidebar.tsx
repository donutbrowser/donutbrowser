"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuLayoutGrid,
  LuLayoutTemplate,
  LuMessageSquare,
  LuPlug,
  LuPlus,
  LuRepeat,
  LuTrash2,
} from "react-icons/lu";
import { ChatSyncLock } from "@/components/agent-chat/sync-lock";
import {
  SearchField,
  SidebarSection,
  sidebarRow,
  useAgentShell,
} from "@/components/agent-shell";
import {
  CreditsMeter,
  StateDot,
  useNextRunWords,
} from "@/components/agent-tasks/parts";
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
  type AgentCredits,
  type AgentRoutine,
  type AgentRoutineDraft,
  batchStatus,
  promptTitle,
} from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";

/** What the main pane of the agent page shows. */
export type PaneSelection =
  | { kind: "new" }
  | { kind: "templates" }
  | { kind: "chat"; id: string }
  | { kind: "run"; id: string }
  | { kind: "routine"; id: string }
  | { kind: "draft"; draft: AgentRoutineDraft; nonce: number };

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

function matches(query: string, ...texts: (string | null | undefined)[]) {
  if (!query) return true;
  return texts.some((text) => text?.toLocaleLowerCase().includes(query));
}

/** Two lines: what it is, and how it is doing. */
function RowText({
  title,
  detail,
  muted,
}: {
  title: string;
  detail: ReactNode;
  muted?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col py-1.5">
      <span
        className={cn("truncate leading-5", muted && "text-muted-foreground")}
      >
        {title}
      </span>
      <span className="flex min-w-0 gap-1 text-[11px] leading-4 text-muted-foreground">
        {detail}
      </span>
    </span>
  );
}

function ChatRow({
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
        className={sidebarRow(selected, "pr-9")}
      >
        <span className="grid size-3.5 shrink-0 place-items-center">
          {live && chat.status ? (
            <StateDot status={chat.status} />
          ) : (
            <LuMessageSquare
              className="size-3.5 text-muted-foreground"
              aria-hidden="true"
            />
          )}
        </span>
        <RowText
          title={chat.title}
          detail={
            <>
              <span className="truncate">{profileName}</span>
              <span aria-hidden="true">·</span>
              <Age at={chat.updatedAt} now={now} />
            </>
          }
        />
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
          "absolute top-1/2 right-1.5 size-7 -translate-y-1/2 rounded-lg p-0 opacity-0 group-hover/chat:opacity-100 focus-visible:opacity-100",
          confirming &&
            "bg-destructive/10 text-destructive-text opacity-100 hover:bg-destructive/15",
        )}
      >
        <LuTrash2 className="size-3.5" aria-hidden="true" />
      </Button>
    </li>
  );
}

function RunRow({
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
  const total = batch.tasks.length;
  const ended = tally.done + tally.failed + tally.stopped;
  return (
    <li>
      <button
        type="button"
        data-slot="agent-run-item"
        data-batch-id={batch.id}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={sidebarRow(selected)}
      >
        {batch.finished ? (
          <LuLayoutGrid
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <span className="grid size-3.5 shrink-0 place-items-center">
            <StateDot status={batchStatus(batch)} />
          </span>
        )}
        <RowText
          title={promptTitle(batch.prompt)}
          detail={
            batch.finished ? (
              <>
                <span className="truncate">
                  {t("agent.tasks.profileCount", { count: total })}
                </span>
                <span aria-hidden="true">·</span>
                <Age at={batch.createdAt} now={now} />
              </>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-1 min-w-6 flex-1 overflow-hidden rounded-full bg-foreground/8"
                >
                  <span
                    className="block h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
                    style={{
                      width: `${total ? Math.max(4, (ended / total) * 100) : 0}%`,
                    }}
                  />
                </span>
                <span className="shrink-0 tabular-nums">
                  {t("agent.tasks.progress", { done: ended, total })}
                </span>
              </span>
            )
          }
        />
      </button>
    </li>
  );
}

function RoutineRow({
  routine,
  selected,
  now,
  onSelect,
}: {
  routine: AgentRoutine;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const nextRun = useNextRunWords();
  return (
    <li>
      <button
        type="button"
        data-slot="agent-routine-item"
        data-routine-id={routine.id}
        data-enabled={routine.enabled ? "true" : "false"}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={sidebarRow(selected)}
      >
        <LuRepeat
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <RowText
          title={routine.name}
          muted={!routine.enabled}
          detail={<span className="truncate">{nextRun(routine, now)}</span>}
        />
      </button>
    </li>
  );
}

/**
 * The agent page's sidebar: a new chat, search, what runs now, routines and
 * the chat history; credits and the way to connected agents at the foot.
 */
export function AgentSidebar({
  chats,
  batches,
  routines,
  selected,
  profileNames,
  credits,
  needsYou,
  onSelect,
  onOpenConsole,
}: {
  chats: AgentChatSummary[];
  batches: AgentBatch[];
  routines: AgentRoutine[];
  selected: PaneSelection;
  profileNames: Map<string, string>;
  credits: AgentCredits | null;
  /** Requests of connected agents that wait for the person. */
  needsYou: number;
  onSelect: (selection: PaneSelection) => void;
  onOpenConsole: () => void;
}) {
  const { t } = useTranslation();
  const { closeSidebar } = useAgentShell();
  const now = useMinuteClock();
  const [query, setQuery] = useState("");
  const q = query.trim().toLocaleLowerCase();
  const is = (kind: PaneSelection["kind"], id: string) =>
    selected.kind === kind && "id" in selected && selected.id === id;
  const nameOf = (profileId: string) =>
    profileNames.get(profileId) ?? t("agent.tasks.unknownProfile");

  const choose = (selection: PaneSelection) => {
    onSelect(selection);
    closeSidebar();
  };

  const liveRuns = batches.filter(
    (batch) => !batch.finished && matches(q, batch.prompt),
  );
  const liveChats = chats.filter(
    (chat) =>
      chat.status !== null &&
      isTurnActive({ status: chat.status }) &&
      matches(q, chat.title, nameOf(chat.profileId)),
  );
  const shownRoutines = routines.filter((routine) =>
    matches(q, routine.name, routine.prompt),
  );
  // Chats and finished runs, newest first.
  const history = useMemo(() => {
    const items: (
      | { kind: "chat"; at: number; chat: AgentChatSummary }
      | { kind: "run"; at: number; batch: AgentBatch }
    )[] = [
      ...chats
        .filter(
          (chat) =>
            !(chat.status !== null && isTurnActive({ status: chat.status })),
        )
        .map((chat) => ({ kind: "chat" as const, at: chat.updatedAt, chat })),
      ...batches
        .filter((batch) => batch.finished)
        .map((batch) => ({
          kind: "run" as const,
          at: batch.createdAt,
          batch,
        })),
    ];
    return items.sort((a, b) => b.at - a.at);
  }, [chats, batches]);
  const shownHistory = history.filter((item) =>
    item.kind === "chat"
      ? matches(
          q,
          item.chat.title,
          item.chat.profileName ?? profileNames.get(item.chat.profileId),
        )
      : matches(q, item.batch.prompt),
  );
  const nothing =
    q.length > 0 &&
    liveRuns.length + liveChats.length + shownRoutines.length === 0 &&
    shownHistory.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-col gap-1.5">
        <button
          type="button"
          data-slot="chat-new"
          onClick={() => {
            choose({ kind: "new" });
          }}
          className={sidebarRow(false, "h-9 font-medium")}
        >
          <LuPlus className="size-4 shrink-0" aria-hidden="true" />
          {t("agent.chat.newChat")}
        </button>
        <button
          type="button"
          data-slot="agent-templates-open"
          aria-current={selected.kind === "templates" ? "true" : undefined}
          onClick={() => {
            choose({ kind: "templates" });
          }}
          className={sidebarRow(selected.kind === "templates", "h-9")}
        >
          <LuLayoutTemplate
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          {t("agent.templates.title")}
        </button>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t("common.buttons.search")}
          slot="agent-sidebar-search"
        />
      </div>
      <ChatSyncLock />
      <FadingScrollArea className="-mx-1 min-h-0 flex-1 px-1">
        <div data-slot="chat-list" className="flex flex-col gap-1 pb-2">
          {(liveRuns.length > 0 || liveChats.length > 0) && (
            <SidebarSection label={t("agent.sidebar.live")}>
              {liveRuns.map((batch) => (
                <RunRow
                  key={batch.id}
                  batch={batch}
                  selected={is("run", batch.id)}
                  now={now}
                  onSelect={() => {
                    choose({ kind: "run", id: batch.id });
                  }}
                />
              ))}
              {liveChats.map((chat) => (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  selected={is("chat", chat.id)}
                  profileName={chat.profileName ?? nameOf(chat.profileId)}
                  now={now}
                  onSelect={() => {
                    choose({ kind: "chat", id: chat.id });
                  }}
                  onDeleted={() => {
                    if (is("chat", chat.id)) onSelect({ kind: "new" });
                  }}
                />
              ))}
            </SidebarSection>
          )}
          {shownRoutines.length > 0 && (
            <SidebarSection label={t("agent.chat.routines")}>
              {shownRoutines.map((routine) => (
                <RoutineRow
                  key={routine.id}
                  routine={routine}
                  selected={is("routine", routine.id)}
                  now={now}
                  onSelect={() => {
                    choose({ kind: "routine", id: routine.id });
                  }}
                />
              ))}
            </SidebarSection>
          )}
          {shownHistory.length > 0 && (
            <SidebarSection label={t("agent.chat.chats")}>
              {shownHistory.map((item) =>
                item.kind === "chat" ? (
                  <ChatRow
                    key={item.chat.id}
                    chat={item.chat}
                    selected={is("chat", item.chat.id)}
                    profileName={
                      item.chat.profileName ?? nameOf(item.chat.profileId)
                    }
                    now={now}
                    onSelect={() => {
                      choose({ kind: "chat", id: item.chat.id });
                    }}
                    onDeleted={() => {
                      if (is("chat", item.chat.id)) onSelect({ kind: "new" });
                    }}
                  />
                ) : (
                  <RunRow
                    key={item.batch.id}
                    batch={item.batch}
                    selected={is("run", item.batch.id)}
                    now={now}
                    onSelect={() => {
                      choose({ kind: "run", id: item.batch.id });
                    }}
                  />
                ),
              )}
            </SidebarSection>
          )}
          {nothing && (
            <p className="px-2.5 py-3 text-xs text-muted-foreground">
              {t("agent.sidebar.noMatch")}
            </p>
          )}
        </div>
      </FadingScrollArea>
      <div className="flex shrink-0 flex-col gap-1 pt-1">
        {credits && (
          <div className="px-2.5 pb-1.5">
            <CreditsMeter credits={credits} layout="spread" />
          </div>
        )}
        <button
          type="button"
          data-slot="agent-console-open"
          onClick={() => {
            onOpenConsole();
            closeSidebar();
          }}
          className={sidebarRow(false, "h-9")}
        >
          <LuPlug
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate">
            {t("agent.console.title")}
          </span>
          {needsYou > 0 && (
            <span className="rounded-full bg-warning/15 px-1.5 text-xs tabular-nums text-warning-text">
              {needsYou}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
