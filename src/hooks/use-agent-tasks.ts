import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AgentBatch,
  type AgentCredits,
  type AgentRoutine,
  type AgentStep,
  appendStep,
  getAgentCredits,
  getAgentTaskSteps,
  listAgentBatches,
  listAgentRoutines,
  ROUTINES_CHANGED,
  upsertBatch,
} from "@/lib/agent-tasks";
import { hasAgentAccess } from "@/lib/entitlements";
import type { CloudUser } from "@/types";

/**
 * The agent on this device: whether the account has the `agent` rollout flag.
 * Nothing is asked of the backend without it, so an account without it sees
 * and sends nothing new.
 */
export interface AgentAvailability {
  entitled: boolean;
}

export function useAgentAvailability(
  cloudUser: CloudUser | null,
): AgentAvailability {
  return { entitled: hasAgentAccess(cloudUser) };
}

/** Every run this session, newest first, live. */
export function useAgentBatches(enabled: boolean) {
  const [batches, setBatches] = useState<AgentBatch[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    listAgentBatches()
      .then((list) => {
        if (!cancelled) setBatches(list);
      })
      .catch((error: unknown) => {
        console.warn("Failed to list agent runs:", error);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    const unlisten = listen<AgentBatch>("agent-batch", (event) => {
      setBatches((current) => upsertBatch(current, event.payload));
    });
    return () => {
      cancelled = true;
      void unlisten.then((off) => {
        off();
      });
    };
  }, [enabled]);

  const forget = useCallback((batchId: string) => {
    setBatches((current) => current.filter((batch) => batch.id !== batchId));
  }, []);

  return { batches, loaded, forget, adopt: setBatches };
}

/** The routine library, read again when a routine changes anywhere. */
export function useAgentRoutines(enabled: boolean) {
  const [routines, setRoutines] = useState<AgentRoutine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(() => {
    listAgentRoutines()
      .then((list) => {
        setRoutines(list);
        setError(null);
      })
      .catch((loadError: unknown) => {
        setError(loadError);
      })
      .finally(() => {
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    reload();
    const unlisten = listen(ROUTINES_CHANGED, reload);
    return () => {
      void unlisten.then((off) => {
        off();
      });
    };
  }, [enabled, reload]);

  return { routines, loaded, error, adopt: setRoutines };
}

/** The credits left, read again when a run or a chat turn finishes. */
export function useAgentCredits(
  enabled: boolean,
  batches: AgentBatch[],
  chatTurnsEnded = 0,
) {
  const [credits, setCredits] = useState<AgentCredits | null>(null);
  const finished =
    batches.filter((batch) => batch.finished).length + chatTurnsEnded;

  useEffect(() => {
    // Read again each time another run finishes.
    if (!enabled || finished < 0) return;
    let cancelled = false;
    getAgentCredits()
      .then((value) => {
        if (!cancelled) setCredits(value);
      })
      .catch((error: unknown) => {
        console.warn("Failed to read agent credits:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, finished]);

  return credits;
}

/** The full step stream of one task, live. */
export function useTaskSteps(
  batchId: string | null,
  profileId: string | null,
  taskId: string | null,
) {
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const key = useRef("");

  useEffect(() => {
    setSteps([]);
    if (!batchId || !profileId || !taskId) return;
    const current = `${batchId}:${profileId}:${taskId}`;
    key.current = current;
    let cancelled = false;
    const unlisten = listen<{
      batchId: string;
      profileId: string;
      taskId: string;
      step: AgentStep;
    }>("agent-step", (event) => {
      const { payload } = event;
      if (payload.taskId !== taskId || payload.profileId !== profileId) {
        return;
      }
      setSteps((known) => appendStep(known, payload.step));
    });
    getAgentTaskSteps(batchId, profileId)
      .then((loaded) => {
        if (cancelled || key.current !== current) return;
        setSteps((streamed) =>
          streamed.reduce((all, step) => appendStep(all, step), loaded),
        );
      })
      .catch((error: unknown) => {
        console.warn("Failed to read agent steps:", error);
      });
    return () => {
      cancelled = true;
      void unlisten.then((off) => {
        off();
      });
    };
  }, [batchId, profileId, taskId]);

  return steps;
}
