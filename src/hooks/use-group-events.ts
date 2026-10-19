import { useCallback, useEffect, useState } from "react";
import i18n from "@/i18n";
import { translateBackendError } from "@/lib/backend-errors";
import { groupList } from "@/lib/profile-list-store";
import type { GroupWithCount } from "@/types";

const NO_GROUPS: GroupWithCount[] = [];

function groupsError(err: unknown) {
  return i18n.t("errors.loadGroupsFailed", {
    error: translateBackendError(i18n.t, err),
  });
}

/**
 * Groups with their profile counts, kept current by `groups-changed` and
 * `profiles-changed`. The list comes from the shared store, so every reader
 * shares one load per change. With `enabled: false` (a closed dialog) it
 * loads nothing and listens to nothing.
 */
export function useGroupEvents({ enabled = true }: { enabled?: boolean } = {}) {
  const [groups, setGroups] = useState<GroupWithCount[]>(
    () => groupList.peek() ?? NO_GROUPS,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadGroups = useCallback(async () => {
    try {
      setGroups(await groupList.refresh());
      setError(null);
    } catch (err: unknown) {
      console.error("Failed to load groups:", err);
      setError(groupsError(err));
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const stop = groupList.subscribe({
      value: (list) => {
        setGroups(list);
        setError(null);
      },
      error: (err) => {
        console.error("Failed to load groups:", err);
        setError(groupsError(err));
      },
    });

    void (async () => {
      try {
        const list = await groupList.load();
        if (disposed) return;
        setGroups(list);
        setError(null);
      } catch (err) {
        if (disposed) return;
        console.error("Failed to load groups:", err);
        setError(groupsError(err));
      } finally {
        if (!disposed) setIsLoading(false);
      }
    })();

    return () => {
      disposed = true;
      stop();
    };
  }, [enabled]);

  return {
    groups,
    isLoading,
    error,
    loadGroups,
    clearError,
  };
}
