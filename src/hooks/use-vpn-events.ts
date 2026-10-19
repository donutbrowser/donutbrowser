import { useCallback, useEffect, useState } from "react";
import i18n from "@/i18n";
import { translateBackendError } from "@/lib/backend-errors";
import { countBy, profileList, vpnConfigList } from "@/lib/profile-list-store";
import type { BrowserProfile, VpnConfig } from "@/types";

const NO_VPNS: VpnConfig[] = [];
const NO_USAGE: Record<string, number> = {};

const vpnOf = (profile: BrowserProfile) => profile.vpn_id;

function vpnsError(err: unknown) {
  return i18n.t("errors.loadVpnConfigsFailed", {
    error: translateBackendError(i18n.t, err),
  });
}

/**
 * VPN configs and how many profiles use each, kept current by backend
 * events. Both lists come from the shared store, so every reader shares one
 * load per change. With `enabled: false` (a closed dialog) it loads nothing
 * and listens to nothing.
 */
export function useVpnEvents({ enabled = true }: { enabled?: boolean } = {}) {
  const [vpnConfigs, setVpnConfigs] = useState<VpnConfig[]>(
    () => vpnConfigList.peek() ?? NO_VPNS,
  );
  const [vpnUsage, setVpnUsage] = useState<Record<string, number>>(() => {
    const profiles = profileList.peek();
    return profiles ? countBy(profiles, vpnOf) : NO_USAGE;
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyProfiles = useCallback((profiles: BrowserProfile[]) => {
    setVpnUsage((previous) => countBy(profiles, vpnOf, previous));
  }, []);

  const loadVpnConfigs = useCallback(async () => {
    try {
      setVpnConfigs(await vpnConfigList.refresh());
      setError(null);
    } catch (err: unknown) {
      console.error("Failed to load VPN configs:", err);
      setError(vpnsError(err));
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const stopVpns = vpnConfigList.subscribe({
      value: (list) => {
        setVpnConfigs(list);
        setError(null);
      },
      error: (err) => {
        console.error("Failed to load VPN configs:", err);
        setError(vpnsError(err));
      },
    });
    const stopProfiles = profileList.subscribe({
      value: applyProfiles,
      error: () => undefined,
    });

    void (async () => {
      try {
        const list = await vpnConfigList.load();
        if (disposed) return;
        setVpnConfigs(list);
        setError(null);
      } catch (err) {
        if (disposed) return;
        console.error("Failed to load VPN configs:", err);
        setError(vpnsError(err));
      } finally {
        if (!disposed) setIsLoading(false);
      }
    })();
    profileList.load().then(
      (profiles) => {
        if (!disposed) applyProfiles(profiles);
      },
      (err: unknown) => {
        console.error("Failed to load VPN usage:", err);
      },
    );

    return () => {
      disposed = true;
      stopVpns();
      stopProfiles();
    };
  }, [enabled, applyProfiles]);

  return {
    vpnConfigs,
    vpnUsage,
    isLoading,
    error,
    loadVpnConfigs,
    clearError,
  };
}
