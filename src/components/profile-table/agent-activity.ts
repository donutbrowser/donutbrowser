import type { AgentChat, ChatTurn, ChatTurnEvent } from "@/lib/agent-chat";
import type { AgentBatch, AgentTaskStatus } from "@/lib/agent-tasks";

/**
 * What the agent did last in each profile, for the profile table's Agent
 * column: the newest chat turn or run task, live. Kept free of runtime
 * imports so `agent-activity.test.mjs` loads it directly.
 */

/** Where a row's state comes from: a chat in the profile, or a run on many. */
export type AgentSource =
  | { kind: "chat"; id: string }
  | { kind: "run"; id: string };

export interface AgentRowState {
  source: AgentSource;
  status: AgentTaskStatus;
  /** The newest step, while it works. */
  step: string | null;
  /** The page it opened last. */
  url: string | null;
  result: string | null;
  error: string | null;
  /** When it last changed, in ms. */
  at: number;
}

const LIVE: ReadonlySet<string> = new Set([
  "queued",
  "launching",
  "running",
  "paused",
  "needs_approval",
]);

/** Started and not ended: queued, working, paused or waiting for the person. */
export function isLive(status: string): boolean {
  return LIVE.has(status);
}

function lastUrl(steps: readonly { url?: string }[]): string | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const url = steps[index].url;
    if (url) return url;
  }
  return null;
}

export function chatRowState(
  chatId: string,
  turn: ChatTurn,
  updatedAt: number,
): AgentRowState {
  return {
    source: { kind: "chat", id: chatId },
    status: turn.status,
    step: turn.steps.at(-1)?.text ?? null,
    url: lastUrl(turn.steps),
    result: turn.result,
    error: turn.error,
    at: turn.finishedAt ?? turn.startedAt ?? updatedAt,
  };
}

/** Each task of a run as its profile's state. */
export function runRowStates(
  batch: AgentBatch,
): [profileId: string, state: AgentRowState][] {
  return batch.tasks.map((task) => [
    task.profileId,
    {
      source: { kind: "run", id: batch.id },
      status: task.status,
      step: task.lastStep?.text ?? null,
      url: task.lastStep?.url ?? null,
      result: task.result,
      error: task.error,
      at: task.finishedAt ?? task.startedAt ?? batch.createdAt,
    },
  ]);
}

/** The state a row shows: live work first, then the newest. */
export function preferRow(
  current: AgentRowState | undefined,
  next: AgentRowState,
): AgentRowState {
  if (!current) return next;
  const currentLive = isLive(current.status);
  if (currentLive !== isLive(next.status)) return currentLive ? current : next;
  return next.at >= current.at ? next : current;
}

export function sameRow(a: AgentRowState | undefined, b: AgentRowState) {
  return (
    !!a &&
    a.source.kind === b.source.kind &&
    a.source.id === b.source.id &&
    a.status === b.status &&
    a.step === b.step &&
    a.url === b.url &&
    a.result === b.result &&
    a.error === b.error &&
    a.at === b.at
  );
}

/** The newest chat of each profile, from a list of any order. */
export function newestPerProfile<
  T extends { profileId: string; updatedAt: number },
>(chats: readonly T[]): T[] {
  const newest = new Map<string, T>();
  for (const chat of chats) {
    const known = newest.get(chat.profileId);
    if (!known || chat.updatedAt > known.updatedAt) {
      newest.set(chat.profileId, chat);
    }
  }
  return [...newest.values()];
}

function stripInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,;:!?]|$)/g, "$1$2")
    .trim();
}

function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => stripInline(cell));
}

const SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

/**
 * An answer as the table reads it: the first row of its first table as
 * name and value pairs, and the other lines as plain text, without the
 * markdown marks.
 */
export function readResult(text: string): {
  fields: [string, string][];
  lines: string[];
} {
  const source = text.split("\n");
  const lines: string[] = [];
  let fields: [string, string][] = [];
  let inCode = false;
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const header = tableCells(line);
    if (header && SEPARATOR.test((source[index + 1] ?? "").trim())) {
      const first = tableCells(source[index + 2] ?? "");
      if (first && fields.length === 0) {
        fields = header
          .map((name, cell): [string, string] => [name, first[cell] ?? ""])
          .filter(([name, value]) => name && value);
      }
      index += 2;
      while (tableCells(source[index + 1] ?? "")) index += 1;
      continue;
    }
    const plain = stripInline(
      line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, ""),
    );
    if (plain) lines.push(plain);
  }
  return { fields, lines };
}

/** The answer in one line, for a table cell. */
export function resultLine(text: string): string {
  const { fields, lines } = readResult(text);
  if (fields.length > 0 && lines.length === 0) {
    return fields.map(([name, value]) => `${name}: ${value}`).join(" · ");
  }
  return lines[0] ?? fields.map(([, value]) => value).join(" · ");
}

interface KnownTurn {
  profileId: string;
  index: number;
  turn: ChatTurn;
  updatedAt: number;
}

/**
 * The Agent column's state of every profile, outside React state: a step
 * tells only the row whose line changed, so the table itself never
 * re-renders for the agent.
 */
export class AgentActivityStore {
  private turns = new Map<string, KnownTurn>();
  private batches = new Map<string, AgentBatch>();
  private rows = new Map<string, AgentRowState>();
  private listeners = new Map<string, Set<() => void>>();
  private summaryListeners = new Set<() => void>();
  private state = { loaded: false, used: false };
  private introId: string | null = null;

  get = (profileId: string): AgentRowState | undefined =>
    this.rows.get(profileId);

  /** Loaded once, and whether the agent has worked anywhere on this device. */
  summary = (): { loaded: boolean; used: boolean } => this.state;

  subscribe = (profileId: string, listener: () => void): (() => void) => {
    let set = this.listeners.get(profileId);
    if (!set) {
      set = new Set();
      this.listeners.set(profileId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(profileId);
    };
  };

  /** The profile the first-task onboarding works in, if it runs. */
  intro = (): string | null => this.introId;

  setIntro(profileId: string | null) {
    if (profileId === this.introId) return;
    this.introId = profileId;
    for (const listener of this.summaryListeners) listener();
  }

  subscribeSummary = (listener: () => void): (() => void) => {
    this.summaryListeners.add(listener);
    return () => {
      this.summaryListeners.delete(listener);
    };
  };

  /** The newest chats as read from disk; a turn heard since stays. */
  setChats(chats: readonly AgentChat[]) {
    const next = new Map<string, KnownTurn>();
    for (const chat of chats) {
      const index = chat.turns.length - 1;
      if (index < 0) continue;
      const heard = this.turns.get(chat.id);
      next.set(
        chat.id,
        heard && heard.updatedAt > chat.updatedAt
          ? heard
          : {
              profileId: chat.profileId,
              index,
              turn: chat.turns[index],
              updatedAt: chat.updatedAt,
            },
      );
    }
    this.turns = next;
    this.recompute();
  }

  applyTurn(event: ChatTurnEvent) {
    const known = this.turns.get(event.chatId);
    if (
      known &&
      (event.index < known.index || event.updatedAt < known.updatedAt)
    ) {
      return;
    }
    this.turns.set(event.chatId, {
      profileId: event.turn.profileId,
      index: event.index,
      turn: event.turn,
      updatedAt: event.updatedAt,
    });
    this.recompute();
  }

  setBatches(batches: readonly AgentBatch[]) {
    this.batches = new Map(batches.map((batch) => [batch.id, batch]));
    this.recompute();
  }

  applyBatch(batch: AgentBatch) {
    this.batches.set(batch.id, batch);
    this.recompute();
  }

  markLoaded() {
    this.state = { ...this.state, loaded: true };
    this.recompute(true);
  }

  clear() {
    this.turns.clear();
    this.batches.clear();
    this.state = { loaded: false, used: false };
    this.recompute(true);
  }

  private recompute(summaryChanged = false) {
    const next = new Map<string, AgentRowState>();
    for (const [chatId, known] of this.turns) {
      const row = chatRowState(chatId, known.turn, known.updatedAt);
      next.set(known.profileId, preferRow(next.get(known.profileId), row));
    }
    for (const batch of this.batches.values()) {
      for (const [profileId, row] of runRowStates(batch)) {
        next.set(profileId, preferRow(next.get(profileId), row));
      }
    }
    const changed: string[] = [];
    for (const [profileId, row] of next) {
      const previous = this.rows.get(profileId);
      if (sameRow(previous, row))
        next.set(profileId, previous as AgentRowState);
      else changed.push(profileId);
    }
    for (const profileId of this.rows.keys()) {
      if (!next.has(profileId)) changed.push(profileId);
    }
    this.rows = next;
    const used = next.size > 0;
    if (used !== this.state.used) {
      this.state = { ...this.state, used };
      summaryChanged = true;
    }
    for (const profileId of changed) {
      for (const listener of this.listeners.get(profileId) ?? []) listener();
    }
    if (summaryChanged) {
      for (const listener of this.summaryListeners) listener();
    }
  }
}
