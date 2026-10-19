import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import i18n from "@/i18n";
import { translateBackendError } from "@/lib/backend-errors";
import { groupList, profileList, sameSetOr } from "@/lib/profile-list-store";
import type { BrowserProfile, GroupWithCount } from "@/types";

interface UseProfileEventsReturn {
  profiles: BrowserProfile[];
  groups: GroupWithCount[];
  runningProfiles: Set<string>;
  isLoading: boolean;
  error: string | null;
  loadProfiles: () => Promise<void>;
  loadGroups: () => Promise<void>;
  clearError: () => void;
}

const NO_PROFILES: BrowserProfile[] = [];
const NO_GROUPS: GroupWithCount[] = [];

function profilesError(err: unknown) {
  return i18n.t("errors.loadProfilesFailed", {
    error: translateBackendError(i18n.t, err),
  });
}

/**
 * Profiles, groups and which profiles run, kept current by backend events.
 * The lists come from the shared store: every reader of them shares one load
 * per change.
 */
export function useProfileEvents(): UseProfileEventsReturn {
  const [profiles, setProfiles] = useState<BrowserProfile[]>(
    () => profileList.peek() ?? NO_PROFILES,
  );
  const [groups, setGroups] = useState<GroupWithCount[]>(
    () => groupList.peek() ?? NO_GROUPS,
  );
  const [runningProfiles, setRunningProfiles] = useState<Set<string>>(
    () => new Set(),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    try {
      setProfiles(await profileList.refresh());
      setError(null);
    } catch (err: unknown) {
      console.error("Failed to load profiles:", err);
      setError(profilesError(err));
    }
  }, []);

  const loadGroups = useCallback(async () => {
    try {
      setGroups(await groupList.refresh());
      setError(null);
    } catch (err) {
      console.error("Failed to load groups with counts:", err);
      setGroups(NO_GROUPS);
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    let disposed = false;
    let runningUnlisten: (() => void) | undefined;

    const stopProfiles = profileList.subscribe({
      value: (list) => {
        setProfiles(list);
        setError(null);
      },
      error: (err) => {
        console.error("Failed to load profiles:", err);
        setError(profilesError(err));
      },
    });
    const stopGroups = groupList.subscribe({
      value: setGroups,
      error: (err) => {
        console.error("Failed to load groups with counts:", err);
      },
    });

    const setup = async () => {
      try {
        const [list, groupsWithCounts] = await Promise.all([
          profileList.load(),
          groupList.load().catch((err: unknown) => {
            console.error("Failed to load groups with counts:", err);
            return NO_GROUPS;
          }),
        ]);
        if (disposed) return;
        setProfiles(list);
        setGroups(groupsWithCounts);
        setError(null);
      } catch (err) {
        if (disposed) return;
        console.error("Failed to load profiles:", err);
        setError(profilesError(err));
      }

      try {
        const unlisten = await listen<{ id: string; is_running: boolean }>(
          "profile-running-changed",
          (event) => {
            const { id, is_running } = event.payload;
            setRunningProfiles((prev) => {
              if (prev.has(id) === is_running) return prev;
              const next = new Set(prev);
              if (is_running) next.add(id);
              else next.delete(id);
              return next;
            });
          },
        );
        if (disposed) unlisten();
        else runningUnlisten = unlisten;
      } catch (err) {
        if (disposed) return;
        console.error("Failed to setup profile event listeners:", err);
        setError(
          i18n.t("errors.setupProfileListenersFailed", {
            error: translateBackendError(i18n.t, err),
          }),
        );
      } finally {
        if (!disposed) setIsLoading(false);
      }
    };

    void setup();

    return () => {
      disposed = true;
      stopProfiles();
      stopGroups();
      runningUnlisten?.();
    };
  }, []);

  // Hydrate the running set from the loaded list: every profile with a
  // stored process_id is a candidate. The Rust status checker emits
  // profile-running-changed for transitions, which update the set one id at
  // a time instead of polling every profile. The set keeps its identity while
  // its members stay the same.
  useEffect(() => {
    setRunningProfiles((prev) => {
      const valid = new Set(profiles.map((p) => p.id));
      const next = new Set<string>();
      for (const id of prev) if (valid.has(id)) next.add(id);
      for (const p of profiles) if (p.process_id != null) next.add(p.id);
      return sameSetOr(prev, next);
    });
  }, [profiles]);

  return {
    profiles,
    groups,
    runningProfiles,
    isLoading,
    error,
    loadProfiles,
    loadGroups,
    clearError,
  };
}
