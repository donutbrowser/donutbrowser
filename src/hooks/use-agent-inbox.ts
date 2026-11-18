import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AgentFocus,
  type AgentWait,
  focusOf,
  INBOX_EVENTS,
  listAgentInbox,
  newWaits,
} from "@/lib/agent-inbox";
import { notifySystem } from "@/lib/system-notify";
import { showToast } from "@/lib/toast-utils";
import { playUiSound } from "@/lib/ui-sounds";

/** Waits are read again this long after the last change, at most. */
const SETTLE_MS = 150;

/** The words of a wait: the question, or the change a chat asks to make. */
export function useWaitWords() {
  const { t } = useTranslation();
  return useCallback(
    (wait: AgentWait) =>
      wait.kind === "change"
        ? t(`agent.inbox.changes.${wait.text}`, { name: wait.subject ?? "" })
        : wait.text,
    [t],
  );
}

/**
 * Everything that waits for the person, live. With `notify`, each new wait
 * posts one notification and, while the agent page is away, a toast whose
 * button opens it.
 */
export function useAgentInbox({
  enabled,
  notify = false,
  pageVisible = false,
  nameOf,
  onOpen,
}: {
  enabled: boolean;
  notify?: boolean;
  pageVisible?: boolean;
  nameOf?: (profileId: string) => string;
  onOpen?: (focus: AgentFocus) => void;
}) {
  const { t } = useTranslation();
  const words = useWaitWords();
  const [waits, setWaits] = useState<AgentWait[]>([]);
  const [loaded, setLoaded] = useState(false);
  const seen = useRef(new Set<string>());
  const latest = useRef({ t, words, pageVisible, nameOf, onOpen, notify });
  latest.current = { t, words, pageVisible, nameOf, onOpen, notify };

  const announce = useCallback((fresh: AgentWait[]) => {
    const {
      t: translate,
      words: say,
      pageVisible: visible,
      nameOf: name,
      onOpen: open,
    } = latest.current;
    if (fresh.length === 0) return;
    playUiSound("attention");
    for (const wait of fresh) {
      const title = translate(
        wait.kind === "change"
          ? "agent.inbox.notifyChange"
          : "agent.inbox.notifyQuestion",
        { name: name?.(wait.profileId) ?? wait.title },
      );
      const body = say(wait);
      void notifySystem({ title, body });
      if (!visible && open) {
        showToast({
          id: `agent-wait-${wait.key}`,
          type: "info",
          title,
          description: body.length > 160 ? `${body.slice(0, 159)}…` : body,
          duration: 12000,
          action: {
            label: translate("agent.notify.open"),
            onClick: () => {
              open(focusOf(wait));
            },
          },
        });
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setWaits([]);
      setLoaded(false);
      return;
    }
    let disposed = false;
    let timer: number | null = null;
    const read = () => {
      timer = null;
      listAgentInbox()
        .then((next) => {
          if (disposed) return;
          const fresh = newWaits(seen.current, next);
          seen.current = new Set(next.map((wait) => wait.key));
          setWaits(next);
          setLoaded(true);
          if (latest.current.notify) announce(fresh);
        })
        .catch((error: unknown) => {
          console.warn("Failed to read the agent inbox:", error);
        });
    };
    const soon = () => {
      if (timer === null) timer = window.setTimeout(read, SETTLE_MS);
    };
    read();
    const unlisten = INBOX_EVENTS.map((name) => listen(name, soon));
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      for (const off of unlisten) {
        void off.then((stop) => {
          stop();
        });
      }
    };
  }, [enabled, announce]);

  return { waits, loaded };
}
