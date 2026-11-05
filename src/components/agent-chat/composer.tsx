"use client";

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { LuArrowUp, LuPause, LuPlay, LuSquare } from "react-icons/lu";
import {
  DEFAULT_RUN_SETTINGS,
  RunOptions,
  type RunSettings,
  startUrlInvalid,
} from "@/components/agent-tasks/parts";
import {
  type Repeat,
  RepeatPicker,
  repeatInvalid,
} from "@/components/agent-tasks/repeat-picker";
import { Button } from "@/components/ui/button";
import {
  type AgentChat,
  type ChatControl,
  composerMode,
  isTurnActive,
} from "@/lib/agent-chat";
import { MAX_PROMPT_CHARS } from "@/lib/agent-tasks";
import { firstBlank } from "@/lib/agent-templates";
import { cn } from "@/lib/utils";

/**
 * What Send does with a new message: a chat in one profile, a run in
 * several, or a routine when it repeats.
 */
export type ComposerTarget = "chat" | "run" | "routine";

export interface ComposerSend {
  text: string;
  target: ComposerTarget;
  repeat: Repeat;
  settings: RunSettings;
}

/** Words and a repeat for the box, from a template. */
export interface ComposerFill {
  text: string;
  repeat: Repeat;
  nonce: number;
}

export function composerTarget(
  profileCount: number,
  repeat: Repeat,
): ComposerTarget {
  if (repeat.kind !== "once") return "routine";
  return profileCount > 1 ? "run" : "chat";
}

/**
 * The message box under a chat. In a new chat it also sets where the task
 * runs and whether it repeats; in a chat it follows up or steers.
 */
export function Composer({
  chat,
  profileCount,
  canSchedule,
  onUpgrade,
  disabled,
  focusKey,
  onSend,
  onControl,
  hero = false,
  leading,
  fill,
}: {
  chat: AgentChat | null;
  /** Profiles chosen for a new chat. */
  profileCount: number;
  canSchedule: boolean;
  onUpgrade: () => void;
  disabled: boolean;
  focusKey: string;
  onSend: (send: ComposerSend) => Promise<boolean>;
  onControl: (action: ChatControl) => void;
  /** The large box of a new chat, with its controls under the words. */
  hero?: boolean;
  /** Controls before the others, such as the profile chips. */
  leading?: ReactNode;
  /** A template to put in the box; a new nonce puts it again. */
  fill?: ComposerFill | null;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const hintId = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [repeat, setRepeat] = useState<Repeat>({ kind: "once" });
  const [settings, setSettings] = useState<RunSettings>(DEFAULT_RUN_SETTINGS);
  const ref = useRef<HTMLTextAreaElement>(null);
  const mode = composerMode(chat);
  const target: ComposerTarget = chat
    ? "chat"
    : composerTarget(profileCount, repeat);
  const turn = chat?.turns.at(-1) ?? null;
  const running = isTurnActive(turn);
  const blocked =
    target !== "chat" && (startUrlInvalid(settings) || repeatInvalid(repeat));

  const fit = useCallback(() => {
    const box = ref.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, hero ? 240 : 160)}px`;
  }, [hero]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the box follows its words
  useLayoutEffect(fit, [fit, text]);

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

  const [filled, setFilled] = useState<number | null>(null);
  if (fill && fill.nonce !== filled) {
    setFilled(fill.nonce);
    setText(fill.text);
    setRepeat(fill.repeat);
  }
  useEffect(() => {
    if (filled === null) return;
    const box = ref.current;
    if (!box) return;
    box.focus();
    // A template's first "[site]" is for the person to fill: select it.
    const blank = firstBlank(box.value);
    if (blank) box.setSelectionRange(blank.start, blank.end);
    else box.setSelectionRange(box.value.length, box.value.length);
  }, [filled]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending || disabled || blocked) return;
    setSending(true);
    const ok = await onSend({ text: value, target, repeat, settings });
    setSending(false);
    if (ok) {
      setText("");
      setRepeat({ kind: "once" });
    }
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
    mode === "steer"
      ? t("agent.chat.placeholderSteer")
      : mode === "followUp"
        ? t("agent.chat.placeholderFollowUp")
        : target === "run"
          ? t("agent.chat.placeholderRun")
          : target === "routine"
            ? t("agent.chat.placeholderRoutine")
            : t("agent.chat.placeholderStart");
  const sendLabel =
    target === "run"
      ? t("agent.tasks.runOn", { count: profileCount })
      : target === "routine"
        ? t("agent.chat.saveRoutine")
        : t("agent.chat.send");

  const controls = (
    <>
      {!chat && (
        <>
          {target !== "chat" && (
            <RunOptions
              value={settings}
              onChange={setSettings}
              autonomy={target === "run"}
              creditCapLabel={
                target === "routine"
                  ? t("agent.routines.creditCap")
                  : t("agent.tasks.creditCap")
              }
            />
          )}
          <RepeatPicker
            key={filled ?? "typed"}
            value={repeat}
            onChange={setRepeat}
            allowOnce
            labelled={hero}
            canSchedule={canSchedule}
            onUpgrade={onUpgrade}
          />
        </>
      )}
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
        disabled={disabled || sending || blocked || !text.trim()}
        aria-busy={sending}
        data-slot="chat-send"
        aria-label={sendLabel}
        title={sendLabel}
        className={
          target === "chat"
            ? "size-8 rounded-xl p-0"
            : "h-8 gap-1.5 rounded-xl px-3 text-xs"
        }
      >
        {target === "chat" ? (
          <LuArrowUp className="size-4" aria-hidden="true" />
        ) : (
          sendLabel
        )}
      </Button>
    </>
  );

  const input = (
    <textarea
      ref={ref}
      id={inputId}
      rows={hero ? 3 : 1}
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
      className={cn(
        "min-w-0 flex-1 resize-none bg-transparent outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
        hero
          ? "max-h-60 min-h-[4.5rem] px-2.5 pt-1.5 text-[15px] leading-6"
          : "max-h-40 min-h-8 px-2 py-1 text-sm leading-6",
      )}
    />
  );

  return (
    <form
      data-slot="chat-composer"
      data-mode={mode}
      data-target={target}
      data-variant={hero ? "hero" : "dock"}
      className="flex shrink-0 flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        {placeholder}
      </label>
      {hero ? (
        <div className="flex flex-col gap-2 rounded-3xl bg-foreground/5 p-2 transition-colors duration-150 focus-within:bg-foreground/7 motion-reduce:transition-none">
          {input}
          <div className="flex min-w-0 items-center gap-1">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {leading}
            </div>
            {controls}
          </div>
        </div>
      ) : (
        <div className="flex items-end gap-1 rounded-2xl bg-foreground/5 p-1.5 transition-colors duration-150 focus-within:bg-foreground/7 motion-reduce:transition-none">
          {input}
          {controls}
        </div>
      )}
      <span
        id={hintId}
        className={cn(
          "truncate px-3 text-[11px] text-muted-foreground",
          hero ? "sr-only" : "hidden [@media(min-height:640px)]:block",
        )}
      >
        {t("agent.chat.hint")}
      </span>
    </form>
  );
}
