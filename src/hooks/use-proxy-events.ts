import { useCallback, useEffect, useState } from "react";
import i18n from "@/i18n";
import { translateBackendError } from "@/lib/backend-errors";
import {
  countBy,
  profileList,
  storedProxyList,
} from "@/lib/profile-list-store";
import type { BrowserProfile, StoredProxy } from "@/types";

const NO_PROXIES: StoredProxy[] = [];
const NO_USAGE: Record<string, number> = {};

const proxyOf = (profile: BrowserProfile) => profile.proxy_id;

function proxiesError(err: unknown) {
  return i18n.t("errors.loadProxiesFailed", {
    error: translateBackendError(i18n.t, err),
  });
}

/**
 * Stored proxies and how many profiles use each, kept current by backend
 * events. Both lists come from the shared store, so every reader shares one
 * load per change. With `enabled: false` (a closed dialog) it loads nothing
 * and listens to nothing.
 */
export function useProxyEvents({ enabled = true }: { enabled?: boolean } = {}) {
  const [storedProxies, setStoredProxies] = useState<StoredProxy[]>(
    () => storedProxyList.peek() ?? NO_PROXIES,
  );
  const [proxyUsage, setProxyUsage] = useState<Record<string, number>>(() => {
    const profiles = profileList.peek();
    return profiles ? countBy(profiles, proxyOf) : NO_USAGE;
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyProfiles = useCallback((profiles: BrowserProfile[]) => {
    setProxyUsage((previous) => countBy(profiles, proxyOf, previous));
  }, []);

  const loadProxies = useCallback(async () => {
    try {
      setStoredProxies(await storedProxyList.refresh());
      setError(null);
    } catch (err: unknown) {
      console.error("Failed to load proxies:", err);
      setError(proxiesError(err));
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const stopProxies = storedProxyList.subscribe({
      value: (list) => {
        setStoredProxies(list);
        setError(null);
      },
      error: (err) => {
        console.error("Failed to load proxies:", err);
        setError(proxiesError(err));
      },
    });
    const stopProfiles = profileList.subscribe({
      value: applyProfiles,
      // Usage counts are not critical: the profile list reports its own
      // errors.
      error: () => undefined,
    });

    void (async () => {
      try {
        const list = await storedProxyList.load();
        if (disposed) return;
        setStoredProxies(list);
        setError(null);
      } catch (err) {
        if (disposed) return;
        console.error("Failed to load proxies:", err);
        setError(proxiesError(err));
      } finally {
        if (!disposed) setIsLoading(false);
      }
    })();
    profileList.load().then(
      (profiles) => {
        if (!disposed) applyProfiles(profiles);
      },
      (err: unknown) => {
        console.error("Failed to load proxy usage:", err);
      },
    );

    return () => {
      disposed = true;
      stopProxies();
      stopProfiles();
    };
  }, [enabled, applyProfiles]);

  return {
    storedProxies,
    proxyUsage,
    isLoading,
    error,
    loadProxies,
    clearError,
  };
}
