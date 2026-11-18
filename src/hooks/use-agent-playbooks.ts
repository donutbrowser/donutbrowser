import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import {
  type AgentPlaybook,
  listAgentPlaybooks,
  PLAYBOOKS_CHANGED,
} from "@/lib/agent-playbooks";

/** The playbooks the account sees, read again when one changes here. */
export function useAgentPlaybooks(enabled: boolean) {
  const [playbooks, setPlaybooks] = useState<AgentPlaybook[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(() => {
    listAgentPlaybooks()
      .then((list) => {
        setPlaybooks(list);
        setError(null);
      })
      .catch((loadError: unknown) => {
        setError(loadError);
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    reload();
    const unlisten = listen(PLAYBOOKS_CHANGED, reload);
    return () => {
      void unlisten.then((off) => {
        off();
      });
    };
  }, [enabled, reload]);

  return { playbooks, error, reload, adopt: setPlaybooks };
}
