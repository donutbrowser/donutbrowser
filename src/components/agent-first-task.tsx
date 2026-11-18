import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LiveFrame, LiveLine } from "@/components/agent-chat/live-view";
import { StateDot, statusLabelKey } from "@/components/agent-tasks/parts";
import { clipAspect, RestingClip } from "@/components/feature-clip";
import type { AgentActivityStore } from "@/components/profile-table/agent-activity";
import {
  agentRowLine,
  ResultBody,
} from "@/components/profile-table/agent-cell";
import { Button } from "@/components/ui/button";
import {
  CoachMark,
  CoachMarkBody,
  CoachMarkClip,
  CoachMarkFooter,
  CoachMarkHeader,
} from "@/components/ui/coach-mark";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { useProfilePreviews } from "@/hooks/use-profile-previews";
import { createAgentChat, isTurnActive } from "@/lib/agent-chat";
import {
  createAgentRoutine,
  isTaskMoving,
  routineFromTurn,
} from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { COACH_MARK_EXIT_MS, type CoachAnchorId } from "@/lib/coach-mark";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";

/** Remembered on this device once the first task is run or skipped. */
const DONE_KEY = "donut.agentFirstTask";

/** How long the Profiles page sits quiet before the offer comes. */
const QUIET_MS = 4000;

/** The template the first task runs: it needs no blanks and no sign-in. */
const FIRST_TEMPLATE = "proxyMatch";

const ANCHORS: readonly CoachAnchorId[] = [
  "agent-intro",
  "column-agent",
  "rail-agent",
];

export function agentFirstTaskDone(): boolean {
  try {
    return window.localStorage.getItem(DONE_KEY) === "done";
  } catch {
    return false;
  }
}

function rememberDone() {
  try {
    window.localStorage.setItem(DONE_KEY, "done");
  } catch {
    // Without storage it is offered again next time, which is harmless.
  }
}

/** Something modal is open, so the offer waits. */
function modalOpen(): boolean {
  return Boolean(
    document.querySelector('[role="dialog"], [role="alertdialog"]'),
  );
}

type Phase =
  | { kind: "off" }
  | { kind: "offer" }
  | { kind: "starting" }
  | { kind: "working"; chatId: string }
  | { kind: "saved"; routineId: string };

/**
 * The agent's first task, for an account with the agent that has not used
 * it on this device: one coach mark on a profile's Agent cell offers a real
 * task in that profile (the "Proxy and fingerprint match" template), shows
 * the live window while it works, then the answer and an offer to keep it as
 * a routine. Every step can be skipped; it never takes the focus.
 */
export function AgentFirstTask({
  eligible,
  visible,
  profileId,
  store,
  onActiveChange,
  onOpenChat,
  onOpenRoutine,
}: {
  /** The page is settled and quiet enough for an offer. */
  eligible: boolean;
  /** The Profiles page shows; elsewhere the mark waits, hidden. */
  visible: boolean;
  /** The profile it works in. */
  profileId: string | null;
  store: AgentActivityStore;
  /** Open, so the day's tip waits. */
  onActiveChange: (active: boolean) => void;
  onOpenChat: (chatId: string) => void;
  onOpenRoutine: (routineId: string) => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: "off" });
  const [leaving, setLeaving] = useState(false);
  const [saving, setSaving] = useState(false);
  const chatId = phase.kind === "working" ? phase.chatId : null;
  const { chat } = useAgentChat(chatId);
  const turn = chat?.turns.at(-1) ?? null;
  const live = turn
    ? isTurnActive(turn)
    : phase.kind === "starting" || phase.kind === "working";
  const [introProfile, setIntroProfile] = useState<string | null>(null);
  const previews = useProfilePreviews(
    introProfile && live ? [introProfile] : [],
    live && introProfile !== null,
  );
  const active = phase.kind !== "off";

  useEffect(() => {
    onActiveChange(active);
  }, [active, onActiveChange]);

  useEffect(() => {
    store.setIntro(active ? introProfile : null);
  }, [active, introProfile, store]);

  useEffect(() => () => store.setIntro(null), [store]);

  // The offer waits for a quiet page with nothing modal on it.
  useEffect(() => {
    if (phase.kind !== "off" || !eligible || !profileId) return;
    if (agentFirstTaskDone()) return;
    let timer = 0;
    const attempt = () => {
      if (modalOpen()) {
        timer = window.setTimeout(attempt, QUIET_MS);
        return;
      }
      setIntroProfile(profileId);
      setLeaving(false);
      setPhase({ kind: "offer" });
    };
    timer = window.setTimeout(attempt, QUIET_MS);
    return () => window.clearTimeout(timer);
  }, [phase.kind, eligible, profileId]);

  // Played out, then gone.
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => {
      setPhase({ kind: "off" });
      setIntroProfile(null);
    }, COACH_MARK_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  if (phase.kind === "off" || !introProfile || !visible) return null;

  const close = () => {
    rememberDone();
    setLeaving(true);
  };

  const start = () => {
    rememberDone();
    setPhase({ kind: "starting" });
    createAgentChat(
      introProfile,
      t(`agent.templates.items.${FIRST_TEMPLATE}.prompt`),
    )
      .then((created) => {
        setPhase({ kind: "working", chatId: created.id });
      })
      .catch((error: unknown) => {
        showErrorToast(translateBackendError(t, error));
        setLeaving(true);
      });
  };

  const save = () => {
    if (!chat || chat.turns.length === 0) return;
    setSaving(true);
    createAgentRoutine({
      ...routineFromTurn(chat, chat.turns.length - 1),
      name: t(`agent.templates.items.${FIRST_TEMPLATE}.title`),
    })
      .then((routine) => {
        setPhase({ kind: "saved", routineId: routine.id });
      })
      .catch((error: unknown) => {
        showErrorToast(translateBackendError(t, error));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const openChat = () => {
    if (chatId) onOpenChat(chatId);
    setLeaving(true);
  };

  const step = (() => {
    if (phase.kind === "offer") return "offer";
    if (phase.kind === "saved") return "saved";
    if (!turn || isTurnActive(turn)) return "working";
    return turn.status === "done" ? "result" : "ended";
  })();

  const status = turn?.status ?? "launching";
  const line = turn
    ? agentRowLine(t, {
        source: { kind: "chat", id: chatId ?? "" },
        status: turn.status,
        step: turn.steps.at(-1)?.text ?? null,
        url: null,
        result: turn.result,
        error: turn.error,
        at: 0,
      })
    : t("agent.tasks.launching");

  const body = () => {
    switch (step) {
      case "offer":
        return (
          <>
            <CoachMarkClip aspect={clipAspect("agent-table")}>
              <RestingClip
                id="agent-table"
                className="absolute inset-0 rounded-[inherit]"
              />
            </CoachMarkClip>
            <CoachMarkHeader title={t("agentIntro.offer.title")} />
            <CoachMarkBody>{t("agentIntro.offer.body")}</CoachMarkBody>
            <CoachMarkFooter>
              <Button
                type="button"
                variant="subtle"
                size="sm"
                data-slot="agent-intro-skip"
                onClick={close}
              >
                {t("agentIntro.notNow")}
              </Button>
              <Button
                type="button"
                size="sm"
                data-slot="agent-intro-start"
                onClick={start}
              >
                {t("agentIntro.offer.start")}
              </Button>
            </CoachMarkFooter>
          </>
        );
      case "working":
        return (
          <>
            <div className="mx-2 mt-2">
              <LiveFrame
                image={previews[introProfile]?.image}
                className="aspect-[16/10] w-full rounded-lg"
              />
            </div>
            <CoachMarkHeader
              eyebrow={
                <>
                  <StateDot
                    status={status}
                    className={cn(
                      "size-1.5",
                      isTaskMoving(status) &&
                        "animate-pulse motion-reduce:animate-none",
                    )}
                  />
                  <span>{t(statusLabelKey(status))}</span>
                </>
              }
              title={t("agentIntro.working.title")}
            />
            <div className="px-4 pt-1.5">
              <LiveLine text={line} className="text-xs text-muted-foreground" />
            </div>
            <CoachMarkBody>{t("agentIntro.working.body")}</CoachMarkBody>
            <CoachMarkFooter>
              <Button
                type="button"
                variant="subtle"
                size="sm"
                data-slot="agent-intro-skip"
                onClick={close}
              >
                {t("agentIntro.hide")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={status === "needs_approval" ? "default" : "subtle"}
                data-slot="agent-intro-open"
                disabled={!chatId}
                onClick={openChat}
              >
                {t("profileTable.agent.openChat")}
              </Button>
            </CoachMarkFooter>
          </>
        );
      case "result":
        return (
          <>
            <CoachMarkHeader title={t("agentIntro.result.title")} />
            <div className="px-4 pt-2" data-slot="agent-intro-result">
              {turn?.result && <ResultBody text={turn.result} />}
            </div>
            <CoachMarkBody>{t("agentIntro.result.body")}</CoachMarkBody>
            <CoachMarkFooter>
              <Button
                type="button"
                variant="subtle"
                size="sm"
                data-slot="agent-intro-skip"
                onClick={close}
              >
                {t("agentIntro.done")}
              </Button>
              <Button
                type="button"
                size="sm"
                data-slot="agent-intro-save"
                disabled={saving}
                onClick={save}
              >
                {t("agent.chat.saveAsRoutine")}
              </Button>
            </CoachMarkFooter>
          </>
        );
      case "ended":
        return (
          <>
            <CoachMarkHeader title={t("agentIntro.ended.title")} />
            <CoachMarkBody>{line}</CoachMarkBody>
            <CoachMarkFooter>
              <Button
                type="button"
                variant="subtle"
                size="sm"
                data-slot="agent-intro-skip"
                onClick={close}
              >
                {t("agentIntro.done")}
              </Button>
              <Button
                type="button"
                size="sm"
                data-slot="agent-intro-open"
                onClick={openChat}
              >
                {t("profileTable.agent.openChat")}
              </Button>
            </CoachMarkFooter>
          </>
        );
      default:
        return (
          <>
            <CoachMarkHeader title={t("agentIntro.saved.title")} />
            <CoachMarkBody>{t("agentIntro.saved.body")}</CoachMarkBody>
            <CoachMarkFooter>
              <Button
                type="button"
                variant="subtle"
                size="sm"
                data-slot="agent-intro-skip"
                onClick={close}
              >
                {t("agentIntro.done")}
              </Button>
              <Button
                type="button"
                size="sm"
                data-slot="agent-intro-routine"
                onClick={() => {
                  if (phase.kind === "saved") onOpenRoutine(phase.routineId);
                  setLeaving(true);
                }}
              >
                {t("agentIntro.saved.open")}
              </Button>
            </CoachMarkFooter>
          </>
        );
    }
  };

  return (
    <CoachMark
      open={!leaving}
      anchors={ANCHORS}
      stepKey={step}
      onDismiss={close}
      onAnchorActivate={step === "offer" ? close : undefined}
      announcement={t("agentIntro.offer.title")}
      data-slot="agent-intro"
      data-step={step}
    >
      {body()}
    </CoachMark>
  );
}
