import { invoke } from "@tauri-apps/api/core";
import type {
  AgentApproval,
  AgentStep,
  AgentTaskStatus,
} from "@/lib/agent-tasks";

/**
 * Agent chats: one conversation with Wayfern's engine in one profile's
 * browser. The thin client over `src-tauri/src/agent_tasks/chat.rs`.
 */

/** Mirrors `TurnKind`: a follow-up that had to start over is `fresh`. */
export type ChatTurnKind = "start" | "follow_up" | "fresh";

export interface ChatSteer {
  text: string;
  at: number;
}

export interface ChatTurn {
  id: string;
  text: string;
  kind: ChatTurnKind;
  steers: ChatSteer[];
  profileId: string;
  taskId: string | null;
  status: AgentTaskStatus;
  steps: AgentStep[];
  approval: AgentApproval | null;
  result: string | null;
  error: string | null;
  creditsUsed: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface AgentChat {
  id: string;
  title: string;
  profileId: string;
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
}

export interface AgentChatSummary {
  id: string;
  title: string;
  profileId: string;
  createdAt: number;
  updatedAt: number;
  status: AgentTaskStatus | null;
  turns: number;
}

/** The `agent-chat-turn` event: the current turn of a chat changed. */
export interface ChatTurnEvent {
  chatId: string;
  index: number;
  updatedAt: number;
  turn: ChatTurn;
}

export type ChatControl = "pause" | "resume" | "stop";

export const listAgentChats = () =>
  invoke<AgentChatSummary[]>("list_agent_chats");
export const getAgentChat = (chatId: string) =>
  invoke<AgentChat>("get_agent_chat", { chatId });
export const createAgentChat = (profileId: string, text: string) =>
  invoke<AgentChat>("create_agent_chat", { profileId, text });
export const sendAgentChatMessage = (chatId: string, text: string) =>
  invoke<AgentChat>("send_agent_chat_message", { chatId, text });
export const controlAgentChat = (chatId: string, action: ChatControl) =>
  invoke<void>("control_agent_chat", { chatId, action });
export const answerAgentChatApproval = (
  chatId: string,
  approvalId: string,
  approve: boolean,
  text?: string,
) =>
  invoke<void>("answer_agent_chat_approval", {
    chatId,
    approvalId,
    approve,
    text: text ?? null,
  });
export const deleteAgentChat = (chatId: string) =>
  invoke<void>("delete_agent_chat", { chatId });

const ACTIVE: ReadonlySet<AgentTaskStatus> = new Set([
  "queued",
  "launching",
  "running",
  "paused",
  "needs_approval",
]);

export function isTurnActive(
  turn: { status: AgentTaskStatus } | null | undefined,
): boolean {
  return turn ? ACTIVE.has(turn.status) : false;
}

/** What the composer does with the next message. */
export function composerMode(
  chat: AgentChat | null,
): "start" | "followUp" | "steer" {
  const last = chat?.turns.at(-1);
  if (!chat || !last) return "start";
  return isTurnActive(last) ? "steer" : "followUp";
}

/**
 * A chat with a changed turn. A turn of another chat, or one older than what
 * the chat already shows, leaves it as it was.
 */
export function applyTurnEvent(
  chat: AgentChat,
  event: ChatTurnEvent,
): AgentChat {
  if (
    event.chatId !== chat.id ||
    event.index > chat.turns.length ||
    event.updatedAt < chat.updatedAt
  ) {
    return chat;
  }
  const turns = chat.turns.slice();
  turns[event.index] = event.turn;
  return {
    ...chat,
    turns,
    updatedAt: Math.max(chat.updatedAt, event.updatedAt),
  };
}

/** The list after a turn changed: newest first. */
export function applyTurnToList(
  list: readonly AgentChatSummary[],
  event: ChatTurnEvent,
): AgentChatSummary[] {
  const index = list.findIndex((chat) => chat.id === event.chatId);
  if (index === -1) return list as AgentChatSummary[];
  const next = list.slice();
  next[index] = {
    ...next[index],
    status: event.turn.status,
    turns: Math.max(next[index].turns, event.index + 1),
    updatedAt: Math.max(next[index].updatedAt, event.updatedAt),
  };
  return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Only the plain web links of an answer open, in the system browser. */
export function isExternalLink(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** When a chat was last used, in words for the list. */
export function chatAge(
  at: number,
  now: number,
  language: string,
): { kind: "now" } | { kind: "text"; text: string } {
  const elapsed = now - at;
  if (elapsed < 60_000) return { kind: "now" };
  const date = new Date(at);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) {
    return {
      kind: "text",
      text: date.toLocaleTimeString(language, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };
  }
  const sameYear = date.getFullYear() === today.getFullYear();
  return {
    kind: "text",
    text: date.toLocaleDateString(language, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    }),
  };
}
