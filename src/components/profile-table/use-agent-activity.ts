import { listen } from "@tauri-apps/api/event";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  type AgentChat,
  type ChatTurnEvent,
  getAgentChat,
  listAgentChats,
} from "@/lib/agent-chat";
import { type AgentBatch, listAgentBatches } from "@/lib/agent-tasks";
import { AgentActivityStore, newestPerProfile } from "./agent-activity";

/** A burst of chat list changes reads the list once. */
const RELOAD_DELAY_MS = 400;

/**
 * What the agent did last in each profile, live. Reads the chats and runs
 * of this device only while `enabled` (the account has the agent), and never
 * asks the cloud.
 */
export function useAgentActivity(enabled: boolean): AgentActivityStore {
  const [store] = useState(() => new AgentActivityStore());

  useEffect(() => {
    if (!enabled) {
      store.clear();
      return;
    }
    let cancelled = false;
    let timer = 0;
    const loadChats = async () => {
      const newest = newestPerProfile(await listAgentChats());
      const chats = await Promise.all(
        newest.map((summary) => getAgentChat(summary.id).catch(() => null)),
      );
      if (!cancelled) {
        store.setChats(chats.filter((chat): chat is AgentChat => !!chat));
      }
    };
    const loadBatches = async () => {
      const batches = await listAgentBatches();
      if (!cancelled) store.setBatches(batches);
    };
    void Promise.allSettled([loadChats(), loadBatches()]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.warn("Failed to read agent activity:", result.reason);
        }
      }
      if (!cancelled) store.markLoaded();
    });
    const offs = [
      listen<ChatTurnEvent>("agent-chat-turn", (event) => {
        store.applyTurn(event.payload);
      }),
      listen<AgentBatch>("agent-batch", (event) => {
        store.applyBatch(event.payload);
      }),
      listen("agent-chats-changed", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          loadChats().catch((error: unknown) => {
            console.warn("Failed to read agent chats:", error);
          });
        }, RELOAD_DELAY_MS);
      }),
    ];
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      for (const off of offs) {
        void off.then((stop) => {
          stop();
        });
      }
    };
  }, [enabled, store]);

  return store;
}

/** One profile's agent state, re-rendering only when it changes. */
export function useAgentRow(store: AgentActivityStore, profileId: string) {
  return useSyncExternalStore(
    (listener) => store.subscribe(profileId, listener),
    () => store.get(profileId),
    () => undefined,
  );
}

export function useAgentSummary(store: AgentActivityStore) {
  return useSyncExternalStore(
    store.subscribeSummary,
    store.summary,
    store.summary,
  );
}

/** Whether the first-task onboarding points at this profile's cell. */
export function useAgentIntro(store: AgentActivityStore, profileId: string) {
  return useSyncExternalStore(
    store.subscribeSummary,
    () => store.intro() === profileId,
    () => false,
  );
}
