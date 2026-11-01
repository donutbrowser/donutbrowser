import { invoke } from "@tauri-apps/api/core";

/**
 * Agent tasks and routines that Wayfern's engine runs. Donut is the interface:
 * this is the thin client over `src-tauri/src/agent_tasks/`.
 */

/** Mirrors `TaskStatus` in `src-tauri/src/agent_tasks/model.rs`. */
export const TASK_STATUSES = [
  "queued",
  "launching",
  "running",
  "paused",
  "needs_approval",
  "done",
  "failed",
  "stopped",
  "no_credits",
  "budget",
] as const;

export type AgentTaskStatus = (typeof TASK_STATUSES)[number];

export type AgentAutonomy = "ask" | "auto";
export type AgentStepKind = "think" | "act" | "observe";
export type AgentControl = "pause" | "resume" | "stop" | "steer";

export interface AgentStep {
  index: number;
  kind: AgentStepKind;
  text: string;
  url?: string;
  tool?: string;
  at: number;
}

export interface AgentApproval {
  approvalId: string;
  question: string;
}

export interface AgentTask {
  profileId: string;
  taskId: string | null;
  runId: string | null;
  status: AgentTaskStatus;
  lastStep: AgentStep | null;
  stepCount: number;
  approval: AgentApproval | null;
  result: string | null;
  error: string | null;
  creditsUsed: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface AgentTally {
  queued: number;
  active: number;
  done: number;
  failed: number;
  stopped: number;
  creditsUsed: number;
}

export interface AgentBatch {
  id: string;
  routineId: string | null;
  prompt: string;
  startUrl: string | null;
  autonomy: AgentAutonomy;
  maxCredits: number | null;
  headless: boolean;
  concurrency: number;
  createdAt: number;
  stopping: boolean;
  finished: boolean;
  tasks: AgentTask[];
  tally: AgentTally;
}

export interface AgentCredits {
  allowance: number;
  used: number;
  extra: number;
  balance: number;
  periodEnd: string | null;
  plan: string | null;
  unlimited: boolean;
}

export interface AgentRoutineSchedule {
  cron: string;
  timezone: string;
}

export interface AgentRoutineDraft {
  name: string;
  prompt: string;
  startUrl: string | null;
  profileIds: string[];
  schedule: AgentRoutineSchedule | null;
  maxCreditsPerRun: number | null;
  concurrency: number | null;
  enabled: boolean;
}

export interface AgentRoutine extends AgentRoutineDraft {
  id: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AgentRoutineRun {
  runId: string;
  batchId: string | null;
  profileId: string | null;
  status: string;
  summary: string | null;
  creditsUsed: number | null;
  error: string | null;
  createdAt: string | null;
  finishedAt: string | null;
}

export interface AgentEngineStatus {
  supported: boolean;
  checked: boolean;
}

export interface AgentTaskRequest {
  profileIds: string[];
  prompt: string;
  startUrl: string | null;
  autonomy: AgentAutonomy;
  maxCredits: number | null;
  concurrency: number | null;
}

export const MAX_PROMPT_CHARS = 8000;
export const MAX_CONCURRENCY = 20;

export const getAgentEngineStatus = () =>
  invoke<AgentEngineStatus>("get_agent_engine_status");
export const getAgentCredits = () => invoke<AgentCredits>("get_agent_credits");
export const startAgentBatch = (request: AgentTaskRequest) =>
  invoke<AgentBatch>("start_agent_batch", { request });
export const listAgentBatches = () =>
  invoke<AgentBatch[]>("list_agent_batches");
export const getAgentTaskSteps = (batchId: string, profileId: string) =>
  invoke<AgentStep[]>("get_agent_task_steps", { batchId, profileId });
export const controlAgentTask = (
  batchId: string,
  profileId: string,
  action: AgentControl,
  message?: string,
) =>
  invoke<void>("control_agent_task", {
    batchId,
    profileId,
    action,
    message: message ?? null,
  });
export const answerAgentApproval = (
  batchId: string,
  profileId: string,
  approvalId: string,
  approve: boolean,
  text?: string,
) =>
  invoke<void>("answer_agent_approval", {
    batchId,
    profileId,
    approvalId,
    approve,
    text: text ?? null,
  });
export const stopAgentBatch = (batchId: string) =>
  invoke<void>("stop_agent_batch", { batchId });
export const retryAgentBatch = (batchId: string) =>
  invoke<number>("retry_agent_batch", { batchId });
export const dismissAgentBatch = (batchId: string) =>
  invoke<void>("dismiss_agent_batch", { batchId });
export const listAgentRoutines = () =>
  invoke<AgentRoutine[]>("list_agent_routines");
export const createAgentRoutine = (routine: AgentRoutineDraft) =>
  invoke<AgentRoutine>("create_agent_routine", { routine });
export const updateAgentRoutine = (id: string, routine: AgentRoutineDraft) =>
  invoke<AgentRoutine>("update_agent_routine", { id, routine });
export const deleteAgentRoutine = (id: string) =>
  invoke<void>("delete_agent_routine", { id });
export const listAgentRoutineRuns = (id: string) =>
  invoke<AgentRoutineRun[]>("list_agent_routine_runs", { id });
export const runAgentRoutine = (id: string, profileIds?: string[]) =>
  invoke<AgentBatch>("run_agent_routine", {
    id,
    profileIds: profileIds ?? null,
  });

const ACTIVE: ReadonlySet<AgentTaskStatus> = new Set([
  "launching",
  "running",
  "paused",
  "needs_approval",
]);

export function isTaskActive(status: AgentTaskStatus): boolean {
  return ACTIVE.has(status);
}

export function isTaskFinal(status: AgentTaskStatus): boolean {
  return !ACTIVE.has(status) && status !== "queued";
}

/**
 * What a status means to the person, one color each: working is primary,
 * needs you is warning, done is success, failed is destructive, and waiting
 * or stopped is a quiet foreground tint.
 */
export const TASK_STATES = ["working", "needs_you", "done", "failed"] as const;
export type TaskState = (typeof TASK_STATES)[number] | "idle";

export function taskState(status: AgentTaskStatus | string): TaskState {
  switch (status) {
    case "launching":
    case "running":
    case "paused":
      return "working";
    case "needs_approval":
      return "needs_you";
    case "done":
      return "done";
    case "failed":
    case "no_credits":
    case "budget":
      return "failed";
    default:
      return "idle";
  }
}

/** The fill of a state's dot or segment. */
export const STATE_FILL: Record<TaskState, string> = {
  working: "bg-primary",
  needs_you: "bg-warning",
  done: "bg-success",
  failed: "bg-destructive",
  idle: "bg-foreground/15",
};

/** The text color of a line that reports a state. */
export const STATE_TEXT: Record<TaskState, string> = {
  working: "text-muted-foreground",
  needs_you: "text-warning-text",
  done: "text-muted-foreground",
  failed: "text-destructive-text",
  idle: "text-muted-foreground",
};

/** A task the engine is moving right now; only these animate. */
export function isTaskMoving(status: AgentTaskStatus | string): boolean {
  return status === "running" || status === "launching";
}

export function stateCounts(
  tasks: readonly { status: AgentTaskStatus | string }[],
): Record<TaskState, number> {
  const counts: Record<TaskState, number> = {
    working: 0,
    needs_you: 0,
    done: 0,
    failed: 0,
    idle: 0,
  };
  for (const task of tasks) counts[taskState(task.status)] += 1;
  return counts;
}

/**
 * The rows of a run: a task that needs the person comes first, everything
 * else keeps its place, so the list never shuffles while it works.
 */
export function rowsForAttention<T extends { status: AgentTaskStatus }>(
  tasks: readonly T[],
  filter: TaskState | null = null,
): T[] {
  const shown = filter
    ? tasks.filter((task) => taskState(task.status) === filter)
    : tasks.slice();
  const waiting = shown.filter((task) => task.status === "needs_approval");
  if (waiting.length === 0) return shown;
  return [
    ...waiting,
    ...shown.filter((task) => task.status !== "needs_approval"),
  ];
}

/** Finished share of a batch, 0 to 100. */
export function batchProgress(tally: AgentTally, total: number): number {
  if (total === 0) return 0;
  const ended = tally.done + tally.failed + tally.stopped;
  return Math.round((ended / total) * 100);
}

/** The first line of a prompt, for a title. */
export function promptTitle(prompt: string, max = 90): string {
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Newest first; a batch updated in place keeps its position. */
export function upsertBatch(
  batches: readonly AgentBatch[],
  next: AgentBatch,
): AgentBatch[] {
  const index = batches.findIndex((batch) => batch.id === next.id);
  if (index === -1) return [next, ...batches];
  const copy = batches.slice();
  copy[index] = next;
  return copy;
}

/** Add a streamed step to a list, once, in order. */
export function appendStep(
  steps: readonly AgentStep[],
  step: AgentStep,
): AgentStep[] {
  if (steps.some((known) => known.index === step.index)) {
    return steps as AgentStep[];
  }
  const next = [...steps, step];
  next.sort((a, b) => a.index - b.index);
  return next;
}

export function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host.length > 0
    );
  } catch {
    return false;
  }
}

/** Credits left for the period, and the share used, or null when unlimited. */
export function creditsLeft(
  credits: AgentCredits,
): { left: number; percentUsed: number } | null {
  if (credits.unlimited) return null;
  const total = credits.allowance + credits.extra;
  const percentUsed =
    total <= 0 ? 100 : Math.min(100, Math.round((credits.used / total) * 100));
  return { left: Math.max(0, credits.balance), percentUsed };
}

/** Five or six cron fields. The cloud is the judge; this catches typos. */
export function isCron(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length >= 5 && fields.length <= 6;
}

/** One routine batch, from the runs the cloud lists per profile. */
export interface AgentRoutineBatch {
  batchId: string;
  at: number | null;
  runs: AgentRoutineRun[];
  creditsUsed: number;
}

/** Runs grouped by the batch that started them, newest first. */
export function groupRoutineRuns(
  runs: readonly AgentRoutineRun[],
): AgentRoutineBatch[] {
  const groups = new Map<string, AgentRoutineBatch>();
  for (const run of runs) {
    const batchId = run.batchId ?? run.runId;
    const at = Date.parse(run.createdAt ?? run.finishedAt ?? "");
    let group = groups.get(batchId);
    if (!group) {
      group = { batchId, at: null, runs: [], creditsUsed: 0 };
      groups.set(batchId, group);
    }
    group.runs.push(run);
    group.creditsUsed += run.creditsUsed ?? 0;
    if (Number.isFinite(at) && (group.at === null || at < group.at)) {
      group.at = at;
    }
  }
  return [...groups.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

export type CronWords =
  | { kind: "daily" | "weekdays" | "weekends"; minute: number; hour: number }
  | { kind: "weekly"; minute: number; hour: number; weekday: number }
  | { kind: "hourly"; minute: number }
  | { kind: "minutes"; every: number }
  | { kind: "custom" };

function cronNumber(field: string, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  return value <= max ? value : null;
}

/** The common cron shapes, so a schedule reads as words. */
export function cronWords(cron: string): CronWords {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return { kind: "custom" };
  const [minuteField, hourField, day, month, weekdayField] = fields;
  if (day !== "*" || month !== "*") return { kind: "custom" };
  const every = /^\*\/(\d+)$/.exec(minuteField);
  if (every && hourField === "*" && weekdayField === "*") {
    const n = Number(every[1]);
    return n > 0 && n < 60 ? { kind: "minutes", every: n } : { kind: "custom" };
  }
  const minute = cronNumber(minuteField, 59);
  if (minute === null) return { kind: "custom" };
  if (hourField === "*") {
    return weekdayField === "*"
      ? { kind: "hourly", minute }
      : { kind: "custom" };
  }
  const hour = cronNumber(hourField, 23);
  if (hour === null) return { kind: "custom" };
  switch (weekdayField) {
    case "*":
      return { kind: "daily", minute, hour };
    case "1-5":
      return { kind: "weekdays", minute, hour };
    case "0,6":
    case "6,0":
      return { kind: "weekends", minute, hour };
  }
  const weekday = cronNumber(weekdayField, 7);
  if (weekday === null) return { kind: "custom" };
  return { kind: "weekly", minute, hour, weekday: weekday % 7 };
}
