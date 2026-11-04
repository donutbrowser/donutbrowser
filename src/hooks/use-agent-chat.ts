import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import {
  type AgentChat,
  type AgentChatSummary,
  type AgentChatSync,
  applyTurnEvent,
  applyTurnToList,
  type ChatTurnEvent,
  getAgentChat,
  getAgentChatSync,
  isTurnActive,
  listAgentChats,
  watchAgentChats,
} from "@/lib/agent-chat";

/**
 * Every chat on this device, newest first, live, and how many turns ended
 * since, so the credits can be read again. While shown, chats from the
 * account's other devices arrive sooner.
 */
export function useAgentChats(enabled: boolean) {
  const [chats, setChats] = useState<AgentChatSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [ended, setEnded] = useState(0);

  const reload = useCallback(() => {
    listAgentChats()
      .then(setChats)
      .catch((error: unknown) => {
        console.warn("Failed to list agent chats:", error);
      })
      .finally(() => {
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    reload();
    const offTurn = listen<ChatTurnEvent>("agent-chat-turn", (event) => {
      setChats((current) => applyTurnToList(current, event.payload));
      const { turn } = event.payload;
      if (turn.taskId && !isTurnActive(turn)) setEnded((n) => n + 1);
    });
    const offList = listen("agent-chats-changed", reload);
    watchAgentChats(true).catch((error: unknown) => {
      console.warn("Failed to watch agent chats:", error);
    });
    return () => {
      void watchAgentChats(false).catch(() => undefined);
      for (const off of [offTurn, offList]) {
        void off.then((stop) => {
          stop();
        });
      }
    };
  }, [enabled, reload]);

  return { chats, loaded, ended };
}

/** One chat with every turn, live. */
export function useAgentChat(chatId: string | null) {
  const [chat, setChat] = useState<AgentChat | null>(null);

  useEffect(() => {
    // A chat adopted just before its id was chosen stays while it reloads.
    setChat((current) => (current?.id === chatId ? current : null));
    if (!chatId) return;
    let cancelled = false;
    const pending: ChatTurnEvent[] = [];
    let loaded = false;
    const unlisten = listen<ChatTurnEvent>("agent-chat-turn", (event) => {
      if (event.payload.chatId !== chatId) return;
      if (!loaded) {
        pending.push(event.payload);
        return;
      }
      setChat((current) =>
        current ? applyTurnEvent(current, event.payload) : current,
      );
    });
    // A copy from another device replaced it, or a delete there removed it.
    const offList = listen("agent-chats-changed", () => {
      getAgentChat(chatId)
        .then((value) => {
          if (cancelled) return;
          setChat((current) =>
            current && current.updatedAt > value.updatedAt ? current : value,
          );
        })
        .catch(() => {
          if (!cancelled) setChat(null);
        });
    });
    getAgentChat(chatId)
      .then((value) => {
        if (cancelled) return;
        loaded = true;
        setChat(pending.reduce(applyTurnEvent, value));
      })
      .catch((error: unknown) => {
        console.warn("Failed to read the agent chat:", error);
      });
    return () => {
      cancelled = true;
      for (const off of [unlisten, offList]) {
        void off.then((stop) => {
          stop();
        });
      }
    };
  }, [chatId]);

  return { chat, adopt: setChat };
}

/** Whether this device waits for the account's chat key, live. */
export function useAgentChatSync() {
  const [sync, setSync] = useState<AgentChatSync>({ locked: false });

  useEffect(() => {
    let cancelled = false;
    const off = listen<AgentChatSync>("agent-chat-sync", (event) => {
      setSync(event.payload);
    });
    getAgentChatSync()
      .then((value) => {
        if (!cancelled) setSync(value);
      })
      .catch((error: unknown) => {
        console.warn("Failed to read chat sync:", error);
      });
    return () => {
      cancelled = true;
      void off.then((stop) => {
        stop();
      });
    };
  }, []);

  return { sync, setSync };
}
