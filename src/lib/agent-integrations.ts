import { invoke } from "@tauri-apps/api/core";
import type { AgentRoutineHook } from "@/lib/agent-tasks";

/**
 * A routine's webhook and where its results go, behind the
 * `agentIntegrations` flag. The thin client over
 * `src-tauri/src/agent_tasks/integrations.rs`.
 */

export const SUBSCRIPTION_EVENTS = [
  "run.finished",
  "batch.finished",
  "run.needs_you",
] as const;
export type SubscriptionEvent = (typeof SUBSCRIPTION_EVENTS)[number];

export interface AgentSubscription {
  id: string;
  event: SubscriptionEvent;
  url: string;
  routineId: string | null;
  createdAt: string | null;
  lastError: string | null;
  lastDeliveredAt: string | null;
  /** The signing secret, in the answer to a create only. */
  secret?: string;
}

export const setAgentRoutineHook = (id: string) =>
  invoke<AgentRoutineHook>("set_agent_routine_hook", { id });
export const deleteAgentRoutineHook = (id: string) =>
  invoke<void>("delete_agent_routine_hook", { id });
export const listAgentSubscriptions = () =>
  invoke<AgentSubscription[]>("list_agent_subscriptions");
export const createAgentSubscription = (subscription: {
  event: SubscriptionEvent;
  url: string;
  routineId: string | null;
}) => invoke<AgentSubscription>("create_agent_subscription", { subscription });
export const testAgentSubscription = (id: string) =>
  invoke<AgentSubscription>("test_agent_subscription", { id });
export const deleteAgentSubscription = (id: string) =>
  invoke<void>("delete_agent_subscription", { id });

/** A Slack incoming webhook gets a Slack message; any other URL gets JSON. */
export function isSlackUrl(url: string): boolean {
  try {
    return new URL(url).host === "hooks.slack.com";
  } catch {
    return false;
  }
}

export function isHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" && parsed.host.length > 0;
  } catch {
    return false;
  }
}
