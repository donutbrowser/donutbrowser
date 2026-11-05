"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuUsers } from "react-icons/lu";
import { ChatTurnView } from "@/components/agent-chat/chat-turn";
import {
  Composer,
  type ComposerFill,
  type ComposerSend,
} from "@/components/agent-chat/composer";
import type { HostContext } from "@/components/agent-chat/host-call";
import { LiveView } from "@/components/agent-chat/live-view";
import {
  AgentSidebar,
  type PaneSelection,
} from "@/components/agent-chat/sidebar";
import {
  FeaturedTemplates,
  TemplateGallery,
  templateRepeat,
} from "@/components/agent-chat/templates";
import { AgentShell, SidebarToggle } from "@/components/agent-shell";
import {
  PaneHeader,
  ProfilePicker,
  positiveInt,
  StateDot,
  statusLabelKey,
} from "@/components/agent-tasks/parts";
import { scheduleOf } from "@/components/agent-tasks/repeat-picker";
import { RoutineEditor } from "@/components/agent-tasks/routine-editor";
import { RoutineView } from "@/components/agent-tasks/routine-view";
import { RunPane } from "@/components/agent-tasks/run-pane";
import {
  ConnectedAgentsNav,
  ConnectedAgentsPane,
  type ConnectedAgentsState,
  type ConsoleTab,
} from "@/components/connected-agents";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { useAgentChat, useAgentChats } from "@/hooks/use-agent-chat";
import type { AgentConsole } from "@/hooks/use-agent-console";
import {
  useAgentBatches,
  useAgentCredits,
  useAgentRoutines,
} from "@/hooks/use-agent-tasks";
import { useGroupEvents } from "@/hooks/use-group-events";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { useProfilePreviews } from "@/hooks/use-profile-previews";
import {
  type AgentChat,
  type ChatControl,
  controlAgentChat,
  createAgentChat,
  isTurnActive,
  sendAgentChatMessage,
} from "@/lib/agent-chat";
import {
  type AgentCredits,
  type AgentRoutine,
  createAgentRoutine,
  MAX_CONCURRENCY,
  routineFromBatch,
  routineFromPrompt,
  routineFromTurn,
  startAgentBatch,
} from "@/lib/agent-tasks";
import type { AgentTemplate } from "@/lib/agent-templates";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { BrowserProfile } from "@/types";

/** What the agent page shows: the chats, or a view of connected agents. */
export type AgentView = "chat" | ConsoleTab;

/** Opens a new chat, on the profiles named; several make it a run. */
export interface ChatSeed {
  profileIds: string[];
  nonce: number;
}

function upsertRoutine(list: AgentRoutine[], routine: AgentRoutine) {
  return list.some((item) => item.id === routine.id)
    ? list.map((item) => (item.id === routine.id ? routine : item))
    : [routine, ...list];
}

/** The thread of one chat, beside its profile's window while it works. */
function ChatView({
  chat,
  credits,
  host,
  nameOf,
  composer,
  onOpenAccount,
  onSaveRoutine,
}: {
  chat: AgentChat;
  credits: AgentCredits | null;
  host: HostContext;
  nameOf: (profileId: string) => string;
  composer: ReactNode;
  onOpenAccount: () => void;
  onSaveRoutine: (turnIndex: number) => void;
}) {
  const { t } = useTranslation();
  const animate = useMotionAllowed();
  const threadRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = chat.turns.at(-1);
  const live = isTurnActive(last) && last?.taskId ? last : null;
  const images = useProfilePreviews(
    live ? [chat.profileId] : [],
    live !== null,
  );
  const progress = `${chat.id}:${chat.turns.length}:${last?.steps.length ?? 0}:${last?.status ?? ""}:${last?.steers.length ?? 0}:${last?.hostCalls.length ?? 0}`;

  useEffect(() => {
    if (!progress) return;
    const box = threadRef.current;
    if (!box || !pinned.current) return;
    box.scrollTo({
      top: box.scrollHeight,
      behavior: animate ? "smooth" : "auto",
    });
  }, [progress, animate]);

  const liveProps = live
    ? {
        profileId: chat.profileId,
        profileName: nameOf(chat.profileId),
        status: live.status,
        step:
          live.status === "needs_approval"
            ? t("agent.tasks.needsYou")
            : (live.steps.at(-1)?.text ?? t(statusLabelKey(live.status))),
        url: [...live.steps].reverse().find((step) => step.url)?.url ?? null,
        image: images[chat.profileId]?.image,
      }
    : null;

  return (
    <section
      data-slot="chat-conversation"
      data-chat-id={chat.id}
      className="@container flex min-h-0 min-w-0 flex-1 flex-col gap-2"
    >
      <PaneHeader lead={<SidebarToggle />} title={chat.title}>
        <span
          data-slot="chat-profile"
          className="flex max-w-48 shrink-0 items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 text-xs text-muted-foreground"
        >
          {last && isTurnActive(last) && <StateDot status={last.status} />}
          <span className="truncate">{nameOf(chat.profileId)}</span>
        </span>
      </PaneHeader>
      <div className="flex min-h-0 flex-1 gap-5">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          {liveProps && (
            <div className="shrink-0 @[52rem]:hidden">
              <LiveView layout="strip" {...liveProps} />
            </div>
          )}
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
              {chat.turns.map((turn, index) => (
                <ChatTurnView
                  key={turn.id}
                  chatId={chat.id}
                  turn={turn}
                  credits={credits}
                  host={host}
                  last={index === chat.turns.length - 1}
                  onOpenAccount={onOpenAccount}
                  onSaveRoutine={() => {
                    onSaveRoutine(index);
                  }}
                />
              ))}
            </ol>
          </div>
          <div className="mx-auto w-full max-w-2xl shrink-0">{composer}</div>
        </div>
        {liveProps && (
          <div className="hidden w-[min(40rem,52%)] shrink-0 flex-col @[52rem]:flex">
            <LiveView layout="panel" {...liveProps} />
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The agent page of an account with the agent: chats in one profile, runs in
 * many and routines, with connected agents one step away.
 */
export function AgentWorkspace({
  enabled,
  view,
  onViewChange,
  profiles,
  agentConsole,
  consoleState,
  canSchedule,
  seed,
  onConnectAgent,
  onOpenAccount,
}: {
  /** The page is open: lists load and stay live. */
  enabled: boolean;
  view: AgentView;
  onViewChange: (view: AgentView) => void;
  profiles: BrowserProfile[];
  agentConsole: AgentConsole;
  consoleState: ConnectedAgentsState;
  canSchedule: boolean;
  seed: ChatSeed | null;
  onConnectAgent: () => void;
  onOpenAccount: () => void;
}) {
  const { t } = useTranslation();
  const agentBatches = useAgentBatches(enabled);
  const agentChats = useAgentChats(enabled);
  const credits = useAgentCredits(
    enabled,
    agentBatches.batches,
    agentChats.ended,
  );
  const { routines, adopt: adoptRoutines } = useAgentRoutines(enabled);
  const { groups } = useGroupEvents();
  const { batches } = agentBatches;
  const chats = agentChats.chats;

  const [selection, setSelection] = useState<PaneSelection>({ kind: "new" });
  // Null until the person or a seed chooses; then their choice stays.
  const [draftProfiles, setDraftProfiles] = useState<string[] | null>(null);
  const [focusKey, setFocusKey] = useState("");
  const [fill, setFill] = useState<ComposerFill | null>(null);
  const chatId = selection.kind === "chat" ? selection.id : null;
  const { chat, adopt } = useAgentChat(chatId);

  const usable = useMemo(
    () => profiles.filter((profile) => profile.browser === "wayfern"),
    [profiles],
  );
  // A chat from another device names a profile this one may not have.
  const profileNames = useMemo(
    () =>
      new Map([
        ...chats.flatMap((item) =>
          item.profileName ? [[item.profileId, item.profileName] as const] : [],
        ),
        ...profiles.map((profile) => [profile.id, profile.name] as const),
      ]),
    [chats, profiles],
  );
  const nameOf = (profileId: string) =>
    profileNames.get(profileId) ?? t("agent.tasks.unknownProfile");

  const select = (next: PaneSelection) => {
    setSelection(next);
    setFill(null);
    onViewChange("chat");
    if (next.kind === "new" || next.kind === "chat") {
      setFocusKey(`${next.kind}:${Date.now()}`);
    }
  };

  const pickTemplate = (template: AgentTemplate) => {
    select({ kind: "new" });
    setFill({
      text: t(`agent.templates.items.${template.id}.prompt`),
      repeat: templateRepeat(template, canSchedule),
      nonce: Date.now(),
    });
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
        agentBatches.adopt((current) =>
          current.some((item) => item.id === batch.id)
            ? current
            : [batch, ...current],
        );
        select({ kind: "run", id: batch.id });
      } else {
        if (chosen.length === 0) return false;
        const created = await createAgentChat(chosen[0], text);
        setSelection({ kind: "chat", id: created.id });
        adopt(created);
      }
      setFill(null);
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

  const composer = (hero: boolean) => (
    <Composer
      chat={shown}
      profileCount={chosen.length}
      canSchedule={canSchedule}
      onUpgrade={onOpenAccount}
      disabled={!shown && chosen.length === 0}
      focusKey={focusKey}
      onSend={send}
      onControl={control}
      hero={hero}
      fill={hero ? fill : null}
      leading={
        hero ? (
          <ProfilePicker
            profiles={usable}
            groups={groups}
            selected={chosen}
            onChange={(ids) => {
              setDraftProfiles(ids);
              setFocusKey(`profile:${ids.join(",")}:${Date.now()}`);
            }}
            disabled={usable.length === 0}
            icon={<LuUsers className="size-3.5" aria-hidden="true" />}
            className="h-8 rounded-full bg-foreground/6 px-3 hover:bg-foreground/9"
          />
        ) : null
      }
    />
  );

  const batch =
    selection.kind === "run"
      ? batches.find((item) => item.id === selection.id)
      : undefined;
  const routine =
    selection.kind === "routine"
      ? routines.find((item) => item.id === selection.id)
      : undefined;
  const finishedRuns = batches.filter((item) => item.finished).length;

  const pane = () => {
    if (view !== "chat") {
      return (
        <ConnectedAgentsPane
          tab={view}
          onTab={onViewChange}
          state={consoleState}
          agentConsole={agentConsole}
          profiles={profiles}
          onConnectAgent={onConnectAgent}
          onOpenAccount={onOpenAccount}
        />
      );
    }
    if (batch) {
      return (
        <RunPane
          key={batch.id}
          batch={batch}
          nameOf={nameOf}
          onSaveRoutine={() => {
            select({
              kind: "draft",
              draft: routineFromBatch(batch),
              nonce: Date.now(),
            });
          }}
          onDismissed={(batchId) => {
            agentBatches.forget(batchId);
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
          lead={<SidebarToggle />}
          profiles={usable}
          groups={groups}
          canSchedule={canSchedule}
          onUpgrade={onOpenAccount}
          finishedRuns={finishedRuns}
          onSaved={(saved) => {
            adoptRoutines((current) => upsertRoutine(current, saved));
          }}
          onRan={(started) => {
            agentBatches.adopt((current) =>
              current.some((item) => item.id === started.id)
                ? current
                : [started, ...current],
            );
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
          <PaneHeader
            lead={<SidebarToggle />}
            title={t("agent.routines.new")}
          />
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
    if (selection.kind === "templates") {
      return <TemplateGallery onPick={pickTemplate} />;
    }
    if (shown) {
      return (
        <ChatView
          chat={shown}
          credits={credits}
          host={host}
          nameOf={nameOf}
          composer={composer(false)}
          onOpenAccount={onOpenAccount}
          onSaveRoutine={(index) => {
            select({
              kind: "draft",
              draft: routineFromTurn(shown, index),
              nonce: Date.now(),
            });
          }}
        />
      );
    }
    if (selection.kind === "chat") return <div className="flex-1" />;
    return (
      <section
        data-slot="chat-conversation"
        className="@container relative flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <div className="absolute top-0 left-0 z-10">
          <SidebarToggle />
        </div>
        <FadingScrollArea className="min-h-0 flex-1">
          <div className="flex min-h-full flex-col items-center justify-center px-2 py-6">
            <div className="flex w-full max-w-[42rem] flex-col gap-6">
              <div
                data-slot="chat-empty"
                className="flex flex-col items-center gap-1.5 text-center"
              >
                <h2 className="text-2xl font-semibold">
                  {t("agent.home.title")}
                </h2>
                {usable.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    {t("agent.chat.noProfiles")}
                  </p>
                )}
              </div>
              {composer(true)}
              <FeaturedTemplates
                onPick={pickTemplate}
                onShowAll={() => {
                  select({ kind: "templates" });
                }}
              />
            </div>
          </div>
        </FadingScrollArea>
      </section>
    );
  };

  return (
    <AgentShell
      label={t("agent.shell.sidebar")}
      sidebar={
        view === "chat" ? (
          <AgentSidebar
            chats={chats}
            batches={batches}
            routines={routines}
            selected={selection}
            profileNames={profileNames}
            credits={credits}
            needsYou={agentConsole.openRequests.length}
            onSelect={select}
            onOpenConsole={() => {
              onViewChange("conversation");
            }}
          />
        ) : (
          <ConnectedAgentsNav
            tab={view}
            onTab={onViewChange}
            onBack={() => {
              onViewChange("chat");
            }}
            state={consoleState}
            agentConsole={agentConsole}
            onConnectAgent={onConnectAgent}
          />
        )
      }
    >
      <div data-slot="agent-chat" className="flex min-h-0 flex-1 flex-col">
        {pane()}
      </div>
    </AgentShell>
  );
}
