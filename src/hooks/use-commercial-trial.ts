import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

export interface TrialStatusActive {
  type: "Active";
  remaining_seconds: number;
  days_remaining: number;
  hours_remaining: number;
  minutes_remaining: number;
}

export interface TrialStatusExpired {
  type: "Expired";
}

export type TrialStatus = TrialStatusActive | TrialStatusExpired;

interface UseCommercialTrialReturn {
  trialStatus: TrialStatus | null;
  hasAcknowledged: boolean;
  isLoading: boolean;
  checkTrialStatus: () => Promise<void>;
}

const CHECK_EVERY_MS = 60_000;

/**
 * Whether `next` shows the same as `prev`: the type and, while the trial
 * runs, its days and hours. The minute countdown alone would re-render every
 * user of the hook once a minute for no visible change.
 */
export function sameVisibleTrial(
  prev: TrialStatus | null,
  next: TrialStatus,
): boolean {
  if (!prev || prev.type !== next.type) return false;
  if (prev.type === "Expired" || next.type === "Expired") return true;
  return (
    prev.days_remaining === next.days_remaining &&
    prev.hours_remaining === next.hours_remaining
  );
}

export function useCommercialTrial(): UseCommercialTrialReturn {
  const [trialStatus, setTrialStatus] = useState<TrialStatus | null>(null);
  const [hasAcknowledged, setHasAcknowledged] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  const checkTrialStatus = useCallback(async () => {
    try {
      const [status, acknowledged] = await Promise.all([
        invoke<TrialStatus>("get_commercial_trial_status"),
        invoke<boolean>("has_acknowledged_trial_expiration"),
      ]);
      setTrialStatus((prev) =>
        sameVisibleTrial(prev, status) ? prev : status,
      );
      setHasAcknowledged(acknowledged);
    } catch (error) {
      console.error("Failed to check trial status:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void checkTrialStatus();

    // Check every minute while the window shows, and at once when it comes
    // back.
    const checkIfVisible = () => {
      if (document.visibilityState === "visible") void checkTrialStatus();
    };
    const interval = setInterval(checkIfVisible, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", checkIfVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", checkIfVisible);
    };
  }, [checkTrialStatus]);

  return {
    trialStatus,
    hasAcknowledged,
    isLoading,
    checkTrialStatus,
  };
}
