"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuMessagesSquare } from "react-icons/lu";
import { ChatTurnView } from "@/components/agent-chat/chat-turn";
import { Composer, type ComposerSend } from "@/components/agent-chat/composer";
import type { HostContext } from "@/components/agent-chat/host-call";
import {
  ChatSidebar,
  type PaneSelection,
} from "@/components/agent-chat/sidebar";
import { ChatSyncLock } from "@/components/agent-chat/sync-lock";
import {
  PaneHeader,
  ProfilePicker,
  positiveInt,
  StateDot,
} from "@/components/agent-tasks/parts";
import { scheduleOf } from "@/components/agent-tasks/repeat-picker";
import { RoutineEditor } from "@/components/agent-tasks/routine-editor";
import { RoutineView } from "@/components/agent-tasks/routine-view";
import { RunPane } from "@/components/agent-tasks/run-pane";
import { Button } from "@/components/ui/button";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { useAgentRoutines } from "@/hooks/use-agent-tasks";
import { useGroupEvents } from "@/hooks/use-group-events";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import {
  type AgentChatSummary,
  type ChatControl,
  controlAgentChat,
  createAgentChat,
  isTurnActive,
  sendAgentChatMessage,
} from "@/lib/agent-chat";
import {
  type AgentBatch,
  type AgentCredits,
  type AgentRoutine,
  createAgentRoutine,
  MAX_CONCURRENCY,
  routineFromBatch,
  routineFromPrompt,
  routineFromTurn,
  startAgentBatch,
} from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { BrowserProfile } from "@/types";

/** Opens a new chat, on the profiles named; several make it a run. */
export interface ChatSeed {
  profileIds: string[];
  nonce: number;
}

function EmptyChat({ hasProfiles }: { hasProfiles: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      data-slot="chat-empty"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-6 text-center"
    >
      <span className="grid size-10 place-items-center rounded-2xl bg-primary/10 text-primary">
        <LuMessagesSquare className="size-5" aria-hidden="true" />
      </span>
      <p className="text-base font-medium">{t("agent.chat.emptyTitle")}</p>
      <p className="max-w-sm text-xs leading-5 text-muted-foreground">
        {hasProfiles ? t("agent.chat.emptyBody") : t("agent.chat.noProfiles")}
      </p>
    </div>
  );
}

function upsertRoutine(list: AgentRoutine[], routine: AgentRoutine) {
  return list.some((item) => item.id === routine.id)
    ? list.map((item) => (item.id === routine.id ? routine : item))
    : [routine, ...list];
}

/**
 * Everything the agent does, in one place: chats in one profile, runs in
 * many, and routines that repeat them. The sidebar lists all three; the
 * main pane shows the one chosen.
 */
export function AgentChatPanel({
  chats,
  batches,
  profiles,
  credits,
  canSchedule,
  seed,
  onOpenAccount,
  onBatchStarted,
  onBatchDismissed,
}: {
  chats: AgentChatSummary[];
  batches: AgentBatch[];
  profiles: BrowserProfile[];
  credits: AgentCredits | null;
  canSchedule: boolean;
  seed: ChatSeed | null;
  onOpenAccount: () => void;
  onBatchStarted: (batch: AgentBatch) => void;
  onBatchDismissed: (batchId: string) => void;
}) {
  const { t } = useTranslation();
  const animate = useMotionAllowed();
  const [selection, setSelection] = useState<PaneSelection>({ kind: "new" });
  // Null until the person or a seed chooses; then their choice stays.
  const [draftProfiles, setDraftProfiles] = useState<string[] | null>(null);
  const [focusKey, setFocusKey] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const chatId = selection.kind === "chat" ? selection.id : null;
  const { chat, adopt } = useAgentChat(chatId);
  const { routines, adopt: adoptRoutines } = useAgentRoutines(true);
  const { groups } = useGroupEvents();
  const threadRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const usable = useMemo(
    () => profiles.filter((profile) => profile.browser === "wayfern"),
    [profiles],
  );
  // A chat from another device names a profile this one may not have.
  const profileNames = useMemo(
    () =>
      new Map([
        ...chats.flatMap((chat) =>
          chat.profileName ? [[chat.profileId, chat.profileName] as const] : [],
        ),
        ...profiles.map((profile) => [profile.id, profile.name] as const),
      ]),
    [chats, profiles],
  );
  const nameOf = (profileId: string) =>
    profileNames.get(profileId) ?? t("agent.tasks.unknownProfile");

  const select = (next: PaneSelection) => {
    setSelection(next);
    setListOpen(false);
    pinned.current = true;
    if (next.kind === "new" || next.kind === "chat") {
      setFocusKey(`${next.kind}:${Date.now()}`);
    }
  };

  const [seenSeed, setSeenSeed] = useState<number | null>(null);
  if (seed && seed.nonce !== seenSeed) {
    setSeenSeed(seed.nonce);
    setSelection({ kind: "new" });
    if (seed.profileIds.length > 0) setDraftProfiles(seed.profileIds);
    setFocusKey(`seed:${seed.nonce}`);
  }

  const shown = chatId && chat?.id === chatId ? chat : null;
  // Deleted on another device while open here.
  const gone =
    chatId !== null && chat === null && !chats.some((c) => c.id === chatId);
  useEffect(() => {
    if (gone) setSelection({ kind: "new" });
  }, [gone]);
  const usableIds = new Set(usable.map((profile) => profile.id));
  const fallback =
    chats.find((c) => usableIds.has(c.profileId))?.profileId ??
    usable[0]?.id ??
    null;
  const chosen =
    draftProfiles === null
      ? fallback
        ? [fallback]
        : []
      : draftProfiles.filter((id) => usableIds.has(id));

  const turns = shown?.turns ?? [];
  const last = turns.at(-1);
  const progress = `${turns.length}:${last?.steps.length ?? 0}:${last?.status ?? ""}:${last?.steers.length ?? 0}:${last?.hostCalls.length ?? 0}`;

  useEffect(() => {
    if (!progress) return;
    const box = threadRef.current;
    if (!box || !pinned.current) return;
    box.scrollTo({
      top: box.scrollHeight,
      behavior: animate ? "smooth" : "auto",
    });
  }, [progress, animate]);

  const send = async ({
    text,
    target,
    repeat,
    settings,
  }: ComposerSend): Promise<boolean> => {
    const startUrl = settings.startUrl.trim() || null;
    const maxCredits = positiveInt(settings.maxCredits);
    const concurrency = positiveInt(settings.concurrency, MAX_CONCURRENCY);
    try {
      if (shown) {
        const next = await sendAgentChatMessage(shown.id, text);
        pinned.current = true;
        adopt((current) =>
          current &&
          current.id === next.id &&
          current.updatedAt > next.updatedAt
            ? current
            : next,
        );
      } else if (target === "routine") {
        const routine = await createAgentRoutine({
          ...routineFromPrompt(text, chosen),
          startUrl,
          schedule: scheduleOf(repeat),
          maxCreditsPerRun: maxCredits,
          concurrency,
        });
        adoptRoutines((current) => upsertRoutine(current, routine));
        showSuccessToast(t("agent.routines.created"));
        select({ kind: "routine", id: routine.id });
      } else if (target === "run") {
        const batch = await startAgentBatch({
          profileIds: chosen,
          prompt: text,
          startUrl,
          autonomy: settings.autonomy,
          maxCredits,
          concurrency,
        });
        onBatchStarted(batch);
        select({ kind: "run", id: batch.id });
      } else {
        if (chosen.length === 0) return false;
        const created = await createAgentChat(chosen[0], text);
        pinned.current = true;
        setSelection({ kind: "chat", id: created.id });
        adopt(created);
      }
      return true;
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
      return false;
    }
  };

  const control = (action: ChatControl) => {
    if (!shown) return;
    controlAgentChat(shown.id, action).catch((error: unknown) => {
      showErrorToast(translateBackendError(t, error));
    });
  };

  const host: HostContext = {
    profiles: usable,
    groups,
    batches,
    canSchedule,
    onUpgrade: onOpenAccount,
    onOpen: select,
  };

  const sidebar = (
    <>
      <ChatSyncLock />
      <ChatSidebar
        chats={chats}
        batches={batches}
        routines={routines}
        selected={selection}
        profileNames={profileNames}
        onSelect={select}
      />
    </>
  );

  const lead = (
    <Popover open={listOpen} onOpenChange={setListOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="subtle"
          size="sm"
          data-slot="chat-list-toggle"
          aria-label={t("agent.chat.chats")}
          title={t("agent.chat.chats")}
          className="size-8 shrink-0 rounded-xl p-0 @[42rem]:hidden"
        >
          <LuMessagesSquare className="size-4" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex h-80 w-64 flex-col p-2">
        {sidebar}
      </PopoverContent>
    </Popover>
  );

  const finishedRuns = batches.filter((batch) => batch.finished).length;
  const batch =
    selection.kind === "run"
      ? batches.find((item) => item.id === selection.id)
      : undefined;
  const routine =
    selection.kind === "routine"
      ? routines.find((item) => item.id === selection.id)
      : undefined;

  const pane = () => {
    if (batch) {
      return (
        <RunPane
          key={batch.id}
          batch={batch}
          lead={lead}
          nameOf={nameOf}
          onSaveRoutine={() => {
            select({
              kind: "draft",
              draft: routineFromBatch(batch),
              nonce: Date.now(),
            });
          }}
          onDismissed={(batchId) => {
            onBatchDismissed(batchId);
            select({ kind: "new" });
          }}
        />
      );
    }
    if (routine) {
      return (
        <RoutineView
          key={routine.id}
          routine={routine}
          lead={lead}
          profiles={usable}
          groups={groups}
          canSchedule={canSchedule}
          onUpgrade={onOpenAccount}
          finishedRuns={finishedRuns}
          onSaved={(saved) => {
            adoptRoutines((current) => upsertRoutine(current, saved));
          }}
          onRan={(started) => {
            onBatchStarted(started);
            select({ kind: "run", id: started.id });
          }}
          onDeleted={() => {
            adoptRoutines((current) =>
              current.filter((item) => item.id !== routine.id),
            );
            select({ kind: "new" });
          }}
        />
      );
    }
    if (selection.kind === "draft") {
      return (
        <section
          data-slot="agent-routine-draft"
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
        >
          <PaneHeader lead={lead} title={t("agent.routines.new")} />
          <FadingScrollArea className="min-h-0 flex-1">
            <div className="mx-auto w-full max-w-2xl py-1">
              <RoutineEditor
                key={selection.nonce}
                id={null}
                initial={selection.draft}
                profiles={usable}
                groups={groups}
                canSchedule={canSchedule}
                onUpgrade={onOpenAccount}
                onCancel={() => {
                  select({ kind: "new" });
                }}
                onSaved={(saved) => {
                  adoptRoutines((current) => upsertRoutine(current, saved));
                  select({ kind: "routine", id: saved.id });
                }}
              />
            </div>
          </FadingScrollArea>
        </section>
      );
    }
    return (
      <section
        data-slot="chat-conversation"
        data-chat-id={shown?.id}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
      >
        <PaneHeader
          lead={lead}
          title={shown ? shown.title : t("agent.chat.newChat")}
        >
          {shown ? (
            <span
              data-slot="chat-profile"
              className="flex max-w-48 shrink-0 items-center gap-1.5 rounded-lg bg-foreground/5 px-2.5 py-1 text-xs text-muted-foreground"
            >
              {last && isTurnActive(last) && <StateDot status={last.status} />}
              <span className="truncate">{nameOf(shown.profileId)}</span>
            </span>
          ) : (
            <ProfilePicker
              profiles={usable}
              groups={groups}
              selected={chosen}
              onChange={(ids) => {
                setDraftProfiles(ids);
                setFocusKey(`profile:${ids.join(",")}:${Date.now()}`);
              }}
              disabled={usable.length === 0}
              className="rounded-xl"
            />
          )}
        </PaneHeader>

        {shown ? (
          <div
            ref={threadRef}
            className="scroll-fade -mx-1 min-h-0 flex-1 overflow-y-auto px-1"
            onScroll={(event) => {
              const box = event.currentTarget;
              pinned.current =
                box.scrollHeight - box.scrollTop - box.clientHeight < 48;
            }}
          >
            <ol
              data-slot="chat-thread"
              aria-live="polite"
              className="mx-auto flex w-full max-w-2xl flex-col gap-5 py-2"
            >
              {shown.turns.map((turn, index) => (
                <ChatTurnView
                  key={turn.id}
                  chatId={shown.id}
                  turn={turn}
                  credits={credits}
                  host={host}
                  last={index === shown.turns.length - 1}
                  onOpenAccount={onOpenAccount}
                  onSaveRoutine={() => {
                    select({
                      kind: "draft",
                      draft: routineFromTurn(shown, index),
                      nonce: Date.now(),
                    });
                  }}
                />
              ))}
            </ol>
          </div>
        ) : selection.kind === "chat" ? (
          <div className="flex-1" />
        ) : (
          <EmptyChat hasProfiles={usable.length > 0} />
        )}

        <div className="mx-auto w-full max-w-2xl shrink-0">
          <Composer
            chat={shown}
            profileCount={chosen.length}
            canSchedule={canSchedule}
            onUpgrade={onOpenAccount}
            disabled={!shown && chosen.length === 0}
            focusKey={focusKey}
            onSend={send}
            onControl={control}
          />
        </div>
      </section>
    );
  };

  return (
    <div
      data-slot="agent-chat"
      className="@container flex min-h-0 flex-1 gap-4"
    >
      <aside
        aria-label={t("agent.chat.chats")}
        className="hidden w-56 shrink-0 flex-col @[42rem]:flex"
      >
        {sidebar}
      </aside>
      {pane()}
    </div>
  );
}
