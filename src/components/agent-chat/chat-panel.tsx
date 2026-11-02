"use client";

import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  LuArrowUp,
  LuMessagesSquare,
  LuPause,
  LuPlay,
  LuPlus,
  LuSquare,
  LuTrash2,
} from "react-icons/lu";
import { ChatTurnView } from "@/components/agent-chat/chat-turn";
import { ProfilePicker, StateDot } from "@/components/agent-tasks/parts";
import { Button } from "@/components/ui/button";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import {
  type AgentChat,
  type AgentChatSummary,
  type ChatControl,
  chatAge,
  composerMode,
  controlAgentChat,
  createAgentChat,
  deleteAgentChat,
  isTurnActive,
  sendAgentChatMessage,
} from "@/lib/agent-chat";
import { type AgentCredits, MAX_PROMPT_CHARS } from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { BrowserProfile } from "@/types";

/** Opens a new chat, on a profile when one is named. */
export interface ChatSeed {
  profileId: string | null;
  nonce: number;
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
  const { t, i18n } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const age = chatAge(chat.updatedAt, now, i18n.language);

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
        className={cn(
          "flex w-full min-w-0 flex-col gap-0.5 rounded-xl px-2.5 py-2 pr-8 text-left transition-colors duration-150 motion-reduce:transition-none",
          selected ? "bg-foreground/7" : "hover:bg-foreground/4",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {live && chat.status && <StateDot status={chat.status} />}
          <span className="truncate text-sm">{chat.title}</span>
        </span>
        <span className="flex min-w-0 gap-1 text-[11px] text-muted-foreground">
          <span className="truncate">{profileName}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 tabular-nums">
            {age.kind === "now" ? t("agent.chat.justNow") : age.text}
          </span>
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

function ChatList({
  chats,
  selectedId,
  profileNames,
  onSelect,
  onNew,
}: {
  chats: AgentChatSummary[];
  selectedId: string | null;
  profileNames: Map<string, string>;
  onSelect: (id: string | null) => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <Button
        type="button"
        variant="subtle"
        size="sm"
        data-slot="chat-new"
        onClick={onNew}
        className={cn(
          "h-8 shrink-0 justify-start gap-2 rounded-xl px-2.5 text-xs",
          selectedId === null && "bg-foreground/7",
        )}
      >
        <LuPlus className="size-3.5" aria-hidden="true" />
        {t("agent.chat.newChat")}
      </Button>
      <FadingScrollArea className="-mx-1 min-h-0 flex-1 px-1">
        <ul
          data-slot="chat-list"
          aria-label={t("agent.chat.chats")}
          className="flex flex-col gap-0.5"
        >
          {chats.map((chat) => (
            <ChatListItem
              key={chat.id}
              chat={chat}
              selected={chat.id === selectedId}
              profileName={
                profileNames.get(chat.profileId) ??
                t("agent.tasks.unknownProfile")
              }
              now={now}
              onSelect={() => {
                onSelect(chat.id);
              }}
              onDeleted={() => {
                if (chat.id === selectedId) onSelect(null);
              }}
            />
          ))}
        </ul>
      </FadingScrollArea>
    </div>
  );
}

function Composer({
  chat,
  disabled,
  focusKey,
  onSend,
  onControl,
}: {
  chat: AgentChat | null;
  disabled: boolean;
  focusKey: string;
  onSend: (text: string) => Promise<boolean>;
  onControl: (action: ChatControl) => void;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const hintId = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const mode = composerMode(chat);
  const turn = chat?.turns.at(-1) ?? null;
  const running = isTurnActive(turn);

  const fit = useCallback(() => {
    const box = ref.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
  }, []);

  useLayoutEffect(fit, [fit]);

  // The page and a closing menu move the focus as they settle, after this
  // mounts; keep it here until they are done.
  useEffect(() => {
    if (!focusKey) return;
    const until = performance.now() + 600;
    let frame = 0;
    const hold = () => {
      const box = ref.current;
      if (box && document.activeElement !== box) box.focus();
      if (performance.now() < until) frame = requestAnimationFrame(hold);
    };
    // The person's own click or key wins at once.
    const release = () => {
      cancelAnimationFrame(frame);
    };
    hold();
    document.addEventListener("pointerdown", release, true);
    return () => {
      release();
      document.removeEventListener("pointerdown", release, true);
    };
  }, [focusKey]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending || disabled) return;
    setSending(true);
    const ok = await onSend(value);
    setSending(false);
    if (ok) setText("");
    ref.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void send();
    }
  };

  const placeholder =
    mode === "start"
      ? t("agent.chat.placeholderStart")
      : mode === "steer"
        ? t("agent.chat.placeholderSteer")
        : t("agent.chat.placeholderFollowUp");

  return (
    <form
      data-slot="chat-composer"
      data-mode={mode}
      className="flex shrink-0 flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        {placeholder}
      </label>
      <div className="flex items-end gap-1 rounded-2xl bg-foreground/5 p-1.5 transition-colors duration-150 focus-within:bg-foreground/7 motion-reduce:transition-none">
        <textarea
          ref={ref}
          id={inputId}
          rows={1}
          value={text}
          maxLength={MAX_PROMPT_CHARS}
          placeholder={placeholder}
          aria-describedby={hintId}
          data-slot="chat-input"
          disabled={disabled}
          onKeyDown={onKeyDown}
          onChange={(event) => {
            setText(event.target.value);
          }}
          className="max-h-40 min-h-8 min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        {running && turn?.taskId && (
          <>
            {turn.status === "paused" ? (
              <Button
                type="button"
                variant="subtle"
                size="sm"
                data-slot="chat-resume"
                aria-label={t("agent.tasks.resume")}
                title={t("agent.tasks.resume")}
                className="size-8 rounded-xl p-0"
                onClick={() => {
                  onControl("resume");
                }}
              >
                <LuPlay className="size-3.5" aria-hidden="true" />
              </Button>
            ) : (
              <Button
                type="button"
                variant="subtle"
                size="sm"
                disabled={turn.status === "needs_approval"}
                data-slot="chat-pause"
                aria-label={t("agent.tasks.pause")}
                title={t("agent.tasks.pause")}
                className="size-8 rounded-xl p-0"
                onClick={() => {
                  onControl("pause");
                }}
              >
                <LuPause className="size-3.5" aria-hidden="true" />
              </Button>
            )}
            <Button
              type="button"
              variant="soft"
              size="sm"
              data-slot="chat-stop"
              aria-label={t("agent.tasks.stop")}
              title={t("agent.tasks.stop")}
              className="size-8 rounded-xl p-0 hover:bg-destructive/10 hover:text-destructive-text"
              onClick={() => {
                onControl("stop");
              }}
            >
              <LuSquare className="size-3 fill-current" aria-hidden="true" />
            </Button>
          </>
        )}
        <Button
          type="submit"
          size="sm"
          disabled={disabled || sending || !text.trim()}
          aria-busy={sending}
          data-slot="chat-send"
          aria-label={t("agent.chat.send")}
          title={t("agent.chat.send")}
          className="size-8 rounded-xl p-0"
        >
          <LuArrowUp className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <span
        id={hintId}
        className="hidden truncate px-3 text-[11px] text-muted-foreground [@media(min-height:640px)]:block"
      >
        {t("agent.chat.hint")}
      </span>
    </form>
  );
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

/** A conversation with the agent in one profile's browser. */
export function AgentChatPanel({
  chats,
  profiles,
  credits,
  seed,
  onOpenAccount,
}: {
  chats: AgentChatSummary[];
  profiles: BrowserProfile[];
  credits: AgentCredits | null;
  seed: ChatSeed | null;
  onOpenAccount: () => void;
}) {
  const { t } = useTranslation();
  const animate = useMotionAllowed();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftProfile, setDraftProfile] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const { chat, adopt } = useAgentChat(selectedId);
  const threadRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const usable = useMemo(
    () => profiles.filter((profile) => profile.browser === "wayfern"),
    [profiles],
  );
  const profileNames = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.name])),
    [profiles],
  );

  const [seenSeed, setSeenSeed] = useState<number | null>(null);
  if (seed && seed.nonce !== seenSeed) {
    setSeenSeed(seed.nonce);
    setSelectedId(null);
    if (seed.profileId) setDraftProfile(seed.profileId);
    setFocusKey(`seed:${seed.nonce}`);
  }

  const shown = selectedId && chat?.id === selectedId ? chat : null;
  const shownId = shown?.id ?? null;

  const draftProfileId =
    draftProfile && usable.some((p) => p.id === draftProfile)
      ? draftProfile
      : (chats.find((c) => usable.some((p) => p.id === c.profileId))
          ?.profileId ??
        usable[0]?.id ??
        null);

  const select = (id: string | null) => {
    setSelectedId(id);
    setListOpen(false);
    pinned.current = true;
    setFocusKey(`chat:${id ?? "new"}:${Date.now()}`);
  };

  const turns = shown?.turns ?? [];
  const last = turns.at(-1);
  const progress = `${turns.length}:${last?.steps.length ?? 0}:${last?.status ?? ""}:${last?.steers.length ?? 0}`;

  useEffect(() => {
    if (!progress) return;
    const box = threadRef.current;
    if (!box || !pinned.current) return;
    box.scrollTo({
      top: box.scrollHeight,
      behavior: animate ? "smooth" : "auto",
    });
  }, [progress, animate]);

  const send = async (text: string): Promise<boolean> => {
    try {
      if (!shown) {
        if (!draftProfileId) return false;
        const created = await createAgentChat(draftProfileId, text);
        pinned.current = true;
        setSelectedId(created.id);
        adopt(created);
      } else {
        const next = await sendAgentChatMessage(shown.id, text);
        pinned.current = true;
        adopt((current) =>
          current &&
          current.id === next.id &&
          current.updatedAt > next.updatedAt
            ? current
            : next,
        );
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

  const list = (
    <ChatList
      chats={chats}
      selectedId={shownId}
      profileNames={profileNames}
      onSelect={select}
      onNew={() => {
        select(null);
      }}
    />
  );

  return (
    <div
      data-slot="agent-chat"
      className="@container flex min-h-0 flex-1 gap-4"
    >
      <aside
        aria-label={t("agent.chat.chats")}
        className="hidden w-52 shrink-0 flex-col @[42rem]:flex"
      >
        {list}
      </aside>

      <section
        data-slot="chat-conversation"
        data-chat-id={shown?.id}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
      >
        <header className="flex shrink-0 items-center gap-2">
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
            <PopoverContent
              align="start"
              className="flex h-80 w-64 flex-col p-2"
            >
              {list}
            </PopoverContent>
          </Popover>
          <h3
            data-slot="chat-title"
            className="min-w-0 flex-1 truncate text-sm font-medium"
          >
            {shown ? shown.title : t("agent.chat.newChat")}
          </h3>
          {shown ? (
            <span
              data-slot="chat-profile"
              className="flex max-w-48 shrink-0 items-center gap-1.5 rounded-lg bg-foreground/5 px-2.5 py-1 text-xs text-muted-foreground"
            >
              {last && isTurnActive(last) && <StateDot status={last.status} />}
              <span className="truncate">
                {profileNames.get(shown.profileId) ??
                  t("agent.tasks.unknownProfile")}
              </span>
            </span>
          ) : (
            <ProfilePicker
              single
              profiles={usable}
              selected={draftProfileId ? [draftProfileId] : []}
              onChange={(ids) => {
                setDraftProfile(ids[0] ?? null);
                setFocusKey(`profile:${ids[0] ?? ""}:${Date.now()}`);
              }}
              disabled={usable.length === 0}
              className="rounded-xl"
            />
          )}
        </header>

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
              {shown.turns.map((turn) => (
                <ChatTurnView
                  key={turn.id}
                  chatId={shown.id}
                  turn={turn}
                  credits={credits}
                  onOpenAccount={onOpenAccount}
                />
              ))}
            </ol>
          </div>
        ) : selectedId !== null ? (
          <div className="flex-1" />
        ) : (
          <EmptyChat hasProfiles={usable.length > 0} />
        )}

        <div className="mx-auto w-full max-w-2xl shrink-0">
          <Composer
            chat={shown}
            disabled={!shown && !draftProfileId}
            focusKey={focusKey}
            onSend={send}
            onControl={control}
          />
        </div>
      </section>
    </div>
  );
}
