import { useCallback, useEffect, useMemo, useState } from "react";
import i18n from "@/i18n";
import {
  getBrowserDisplayName,
  getOSDisplayName,
  isCrossOsProfile,
} from "@/lib/browser-utils";
import type { BrowserProfile } from "@/types";

/**
 * Hook for managing browser state
 */
export function useBrowserState(
  profiles: BrowserProfile[],
  runningProfiles: Set<string>,
  _isUpdating: (browser: string) => boolean,
  launchingProfiles: Set<string>,
  stoppingProfiles: Set<string>,
) {
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  /**
   * Check if a browser type allows only one instance to run at a time
   */
  const isSingleInstanceBrowser = useCallback(
    (_browserType: string): boolean => {
      return false; // No browsers currently require single instance
    },
    [],
  );

  /**
   * Check if any instance of a specific browser type is currently running
   */
  const isAnyInstanceRunning = useCallback(
    (browserType: string): boolean => {
      if (!isClient) return false;
      return profiles.some(
        (p) => p.browser === browserType && runningProfiles.has(p.id),
      );
    },
    [profiles, runningProfiles, isClient],
  );

  /**
   * Check if a profile can be launched (not disabled by single-instance rules)
   */
  const canLaunchProfile = useCallback(
    (profile: BrowserProfile): boolean => {
      if (!isClient) return false;

      if (isCrossOsProfile(profile)) return false;

      const isRunning = runningProfiles.has(profile.id);
      const isLaunching = launchingProfiles.has(profile.id);
      const isStopping = stoppingProfiles.has(profile.id);

      // If the profile is launching or stopping, disable the button
      if (isLaunching || isStopping) {
        return false;
      }

      // If the profile is already running, it can always be stopped
      if (isRunning) return true;

      // For single-instance browsers, check if any instance is running
      if (isSingleInstanceBrowser(profile.browser)) {
        return !isAnyInstanceRunning(profile.browser);
      }

      return true;
    },
    [
      runningProfiles,
      isClient,
      isSingleInstanceBrowser,
      isAnyInstanceRunning,
      launchingProfiles,
      stoppingProfiles,
    ],
  );

  /**
   * Check if a profile can be used for opening links
   * This is more restrictive than canLaunchProfile as it considers running state
   */
  const canUseProfileForLinks = useCallback(
    (profile: BrowserProfile): boolean => {
      if (!isClient) return false;

      const isLaunching = launchingProfiles.has(profile.id);
      const isStopping = stoppingProfiles.has(profile.id);

      // If this specific browser is launching or stopping, block it
      if (isLaunching || isStopping) {
        return false;
      }

      // For single-instance browsers
      if (isSingleInstanceBrowser(profile.browser)) {
        const isRunning = runningProfiles.has(profile.id);
        const runningInstancesOfType = profiles.filter(
          (p) => p.browser === profile.browser && runningProfiles.has(p.id),
        );

        // If no instances are running, any profile of this type can be used
        if (runningInstancesOfType.length === 0) {
          return true;
        }

        // If instances are running, only the running ones can be used
        return isRunning;
      }

      // For other browsers, any profile can be used
      return true;
    },
    [
      profiles,
      runningProfiles,
      isClient,
      isSingleInstanceBrowser,
      launchingProfiles,
      stoppingProfiles,
    ],
  );

  /**
   * Check if a profile can be selected for actions (delete, move group, etc.)
   */
  const canSelectProfile = useCallback(
    (profile: BrowserProfile): boolean => {
      if (!isClient) return false;

      const isRunning = runningProfiles.has(profile.id);
      const isLaunching = launchingProfiles.has(profile.id);
      const isStopping = stoppingProfiles.has(profile.id);

      // If profile is running, launching, or stopping, block selection
      if (isRunning || isLaunching || isStopping) {
        return false;
      }

      return true;
    },
    [isClient, runningProfiles, launchingProfiles, stoppingProfiles],
  );

  /**
   * Get tooltip content for a profile's launch button
   */
  const getLaunchTooltipContent = useCallback(
    (profile: BrowserProfile): string => {
      if (!isClient) return i18n.t("common.buttons.loading");

      if (isCrossOsProfile(profile)) {
        const profileOs = profile.host_os || profile.wayfern_config?.os;
        if (profileOs) {
          return i18n.t("crossOs.cannotLaunch", {
            os: getOSDisplayName(profileOs),
          });
        }
        return i18n.t("crossOs.cannotLaunchUnknown");
      }

      const isRunning = runningProfiles.has(profile.id);
      const isLaunching = launchingProfiles.has(profile.id);
      const isStopping = stoppingProfiles.has(profile.id);

      if (isLaunching) {
        return i18n.t("profileTable.launchTooltip.launching");
      }

      if (isStopping) {
        return i18n.t("profileTable.launchTooltip.stopping");
      }

      if (isRunning) {
        return "";
      }

      if (
        isSingleInstanceBrowser(profile.browser) &&
        !canLaunchProfile(profile)
      ) {
        return i18n.t("profileTable.launchTooltip.singleInstance");
      }

      return "";
    },
    [
      runningProfiles,
      isClient,
      isSingleInstanceBrowser,
      canLaunchProfile,
      launchingProfiles,
      stoppingProfiles,
    ],
  );

  /**
   * Get tooltip content for profile selection (for opening links)
   */
  const getProfileTooltipContent = useCallback(
    (profile: BrowserProfile): string | null => {
      if (!isClient) return null;

      const canUseForLinks = canUseProfileForLinks(profile);

      if (canUseForLinks) return null;

      const isLaunching = launchingProfiles.has(profile.id);
      const isStopping = stoppingProfiles.has(profile.id);

      if (isLaunching) {
        return i18n.t("profileSelector.busy.launching");
      }

      if (isStopping) {
        return i18n.t("profileSelector.busy.stopping");
      }

      if (isSingleInstanceBrowser(profile.browser)) {
        const runningInstancesOfType = profiles.filter(
          (p) => p.browser === profile.browser && runningProfiles.has(p.id),
        );

        if (runningInstancesOfType.length > 0) {
          const runningProfileNames = runningInstancesOfType
            .map((p) => p.name)
            .join(", ");
          return i18n.t("profileSelector.busy.singleInstance", {
            browser: getBrowserDisplayName(profile.browser),
            names: runningProfileNames,
          });
        }
      }

      return i18n.t("profileSelector.busy.unavailable");
    },
    [
      profiles,
      runningProfiles,
      isClient,
      canUseProfileForLinks,
      isSingleInstanceBrowser,
      launchingProfiles,
      stoppingProfiles,
    ],
  );

  // One object while its parts stay the same: a reader that puts it in its
  // dependencies (the profile table's meta) does not change on every render.
  return useMemo(
    () => ({
      isClient,
      isSingleInstanceBrowser,
      isAnyInstanceRunning,
      canLaunchProfile,
      canUseProfileForLinks,
      canSelectProfile,
      getLaunchTooltipContent,
      getProfileTooltipContent,
    }),
    [
      isClient,
      isSingleInstanceBrowser,
      isAnyInstanceRunning,
      canLaunchProfile,
      canUseProfileForLinks,
      canSelectProfile,
      getLaunchTooltipContent,
      getProfileTooltipContent,
    ],
  );
}
