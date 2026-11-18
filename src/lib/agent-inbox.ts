import { invoke } from "@tauri-apps/api/core";

/**
 * Everything that waits for the person across profiles: a question in a run
 * or a chat, and a change a chat asked to make. The thin client over
 * `src-tauri/src/agent_tasks/inbox.rs`, and the way a notification or the
 * rail opens the right chat or run.
 */

export type AgentWaitKind = "question" | "change";

export interface AgentWait {
  /** The same while the wait lasts; new for the next one. */
  key: string;
  kind: AgentWaitKind;
  profileId: string;
  batchId: string | null;
  chatId: string | null;
  routineId: string | null;
  title: string;
  /** The question, or a change's method (`routines.save`, ...). */
  text: string;
  /** A change's routine name or task words. */
  subject: string | null;
  at: number;
}

export const listAgentInbox = () => invoke<AgentWait[]>("list_agent_inbox");

/** Events after which the waits may differ. */
export const INBOX_EVENTS = ["agent-batch", "agent-chat-turn"] as const;

/** The keys of `next` that `seen` did not have. */
export function newWaits(
  seen: ReadonlySet<string>,
  next: readonly AgentWait[],
): AgentWait[] {
  return next.filter((wait) => !seen.has(wait.key));
}

/** What the agent page shows when asked to open a wait. */
export type AgentFocus =
  | { kind: "inbox" }
  | { kind: "chat"; id: string }
  | { kind: "run"; id: string; profileId: string };

export function focusOf(wait: AgentWait): AgentFocus {
  if (wait.chatId) return { kind: "chat", id: wait.chatId };
  if (wait.batchId) {
    return { kind: "run", id: wait.batchId, profileId: wait.profileId };
  }
  return { kind: "inbox" };
}

type FocusListener = (focus: AgentFocus) => void;
const listeners = new Set<FocusListener>();
let pending: AgentFocus | null = null;

/**
 * Ask the agent page to show a wait. A page not open yet takes it when it
 * opens.
 */
export function requestAgentFocus(focus: AgentFocus): void {
  if (listeners.size === 0) {
    pending = focus;
    return;
  }
  for (const listener of listeners) listener(focus);
}

/** Follow focus requests; a waiting one comes at once. */
export function onAgentFocus(listener: FocusListener): () => void {
  listeners.add(listener);
  if (pending) {
    const focus = pending;
    pending = null;
    listener(focus);
  }
  return () => {
    listeners.delete(listener);
  };
}
