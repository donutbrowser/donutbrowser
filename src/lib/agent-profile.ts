import { invoke } from "@tauri-apps/api/core";

/**
 * What the agent knows about a profile: notes kept sealed on this device,
 * whether it reads the profile's history, and its actions today. The thin
 * client over `src-tauri/src/agent_tasks/{memory,options}.rs`.
 */

export interface AgentNote {
  id: string;
  text: string;
  at: number;
  /** The agent wrote it; else the person did. */
  learnt: boolean;
}

export interface AgentProfileMemory {
  /** Newest first. */
  notes: AgentNote[];
  useHistory: boolean;
}

export interface AgentSite {
  host: string;
  visits: number;
}

export interface AgentActionUsage {
  /** The UTC day, YYYY-MM-DD. */
  day: string;
  actions: number;
  sites: { host: string; actions: number }[];
}

export const MAX_NOTE_CHARS = 300;
export const MEMORY_CHANGED = "agent-memory-changed";

export const getAgentProfileMemory = (profileId: string) =>
  invoke<AgentProfileMemory>("get_agent_profile_memory", { profileId });
export const saveAgentMemoryNote = (
  profileId: string,
  noteId: string | null,
  text: string,
) =>
  invoke<AgentProfileMemory>("save_agent_memory_note", {
    profileId,
    noteId,
    text,
  });
export const deleteAgentMemoryNote = (profileId: string, noteId: string) =>
  invoke<AgentProfileMemory>("delete_agent_memory_note", {
    profileId,
    noteId,
  });
export const setAgentHistoryUse = (profileId: string, enabled: boolean) =>
  invoke<AgentProfileMemory>("set_agent_history_use", { profileId, enabled });
export const getAgentProfileSites = (profileId: string) =>
  invoke<AgentSite[]>("get_agent_profile_sites", { profileId });
export const getAgentActionUsage = (profileId: string) =>
  invoke<AgentActionUsage>("get_agent_action_usage", { profileId });
