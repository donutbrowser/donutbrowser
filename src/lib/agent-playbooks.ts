import { invoke } from "@tauri-apps/api/core";

/**
 * Playbooks: written know-how for a site, personal or shared with the team.
 * The thin client over `src-tauri/src/agent_tasks/playbooks.rs`.
 */

export interface AgentPlaybookDraft {
  name: string;
  instructions: string;
  sites: string[];
  shared: boolean;
}

export interface AgentPlaybook extends AgentPlaybookDraft {
  id: string;
  updatedAt: string | null;
  /** The person wrote it or owns the team, so may change it. */
  editable: boolean;
}

export const MAX_PLAYBOOK_CHARS = 8000;
export const MAX_PICKED_PLAYBOOKS = 10;
export const PLAYBOOKS_CHANGED = "agent-playbooks-changed";

export const listAgentPlaybooks = () =>
  invoke<AgentPlaybook[]>("list_agent_playbooks");
export const createAgentPlaybook = (playbook: AgentPlaybookDraft) =>
  invoke<AgentPlaybook>("create_agent_playbook", { playbook });
export const updateAgentPlaybook = (id: string, playbook: AgentPlaybookDraft) =>
  invoke<AgentPlaybook>("update_agent_playbook", { id, playbook });
export const deleteAgentPlaybook = (id: string) =>
  invoke<void>("delete_agent_playbook", { id });

/** Sites typed with commas, spaces or lines, each once. */
export function splitSites(text: string): string[] {
  const sites = text
    .split(/[\s,]+/)
    .map((site) => site.trim())
    .filter(Boolean);
  return [...new Set(sites)];
}
