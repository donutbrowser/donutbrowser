"use client";

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { translateBackendError } from "@/lib/backend-errors";
import { getThemeById, normalizeThemeColors } from "@/lib/themes";
import { showErrorToast } from "@/lib/toast-utils";
import {
  applySoundSettings,
  type SoundSettings as SoundFields,
} from "@/lib/ui-sounds";

export interface AppSettings extends SoundFields {
  set_as_default_browser: boolean;
  theme: string;
  custom_theme?: Record<string, string>;
  api_enabled: boolean;
  api_port: number;
  api_token?: string;
  disable_auto_updates?: boolean;
  keep_decrypted_profiles_in_ram?: boolean;
  fingerprint_gate_disabled?: boolean;
  vpn_extension_warning_disabled?: boolean;
  require_route_for_launch?: boolean;
  ask_route_for_launch?: boolean;
  trash_retention_days?: number;
  record_traffic_domains?: boolean;
  bulk_launch_delay_ms?: number;
  bulk_launch_concurrency?: number;
  system_notifications?: boolean;
  launch_at_login?: boolean;
  reopen_running_profiles?: boolean;
}

/** Edits close together (a slider drag, color picks) go out as one save. */
const SAVE_DELAY_MS = 350;

const DEFAULTS: AppSettings = {
  set_as_default_browser: false,
  theme: "system",
  api_enabled: false,
  api_port: 10108,
};

/** A stored palette, or Tokyo Night when none is stored yet. */
function withCustomTheme(settings: AppSettings): AppSettings {
  const stored = settings.custom_theme;
  return {
    ...settings,
    custom_theme:
      stored && Object.keys(stored).length > 0
        ? normalizeThemeColors(stored)
        : (getThemeById("tokyo-night")?.colors ?? {}),
  };
}

export type SaveState = "idle" | "pending" | "saving";

/**
 * The app settings, saved as they change. A failed save shows the backend
 * error and puts the last saved values back.
 */
export function useAutosavedSettings(isOpen: boolean) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [isLoading, setIsLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const draftRef = useRef<AppSettings>(DEFAULTS);
  const savedRef = useRef<AppSettings | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const inFlightRef = useRef(0);

  const adopt = useCallback((next: AppSettings) => {
    draftRef.current = next;
    setSettings(next);
  }, []);

  const persist = useCallback(() => {
    timerRef.current = null;
    const draft = draftRef.current;
    inFlightRef.current += 1;
    setSaveState("saving");
    queueRef.current = queueRef.current.then(async () => {
      try {
        const stored = withCustomTheme(
          await invoke<AppSettings>("save_app_settings", { settings: draft }),
        );
        savedRef.current = stored;
        applySoundSettings(stored);
        if (draftRef.current === draft) adopt(stored);
      } catch (error) {
        showErrorToast(t("appFeedback.saveFailed"), {
          description: translateBackendError(t, error),
        });
        if (savedRef.current && draftRef.current === draft) {
          adopt(savedRef.current);
        }
      } finally {
        inFlightRef.current -= 1;
        if (inFlightRef.current === 0 && timerRef.current === null) {
          setSaveState("idle");
        }
      }
    });
  }, [adopt, t]);

  const update = useCallback(
    (patch: Partial<AppSettings>) => {
      if (!savedRef.current) return;
      adopt({ ...draftRef.current, ...patch });
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(persist, SAVE_DELAY_MS);
      setSaveState("pending");
    },
    [adopt, persist],
  );

  // Leaving the page sends an edit that is still waiting.
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        persist();
      }
    },
    [persist],
  );

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      try {
        let stored = withCustomTheme(
          await invoke<AppSettings>("get_app_settings"),
        );
        // One-shot migration off the old localStorage flag, so a user who
        // turned the warning off does not start getting hard blocks.
        try {
          if (
            localStorage.getItem("consistency-warn-disabled") === "1" &&
            !stored.fingerprint_gate_disabled
          ) {
            stored = withCustomTheme(
              await invoke<AppSettings>("save_app_settings", {
                settings: { ...stored, fingerprint_gate_disabled: true },
              }),
            );
          }
          localStorage.removeItem("consistency-warn-disabled");
        } catch (err) {
          console.warn(
            "Failed to migrate consistency warning preference:",
            err,
          );
        }
        if (cancelled) return;
        savedRef.current = stored;
        adopt(stored);
        setLoaded(true);
      } catch (error) {
        console.error("Failed to load settings:", error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, adopt]);

  return { settings, update, isLoading, loaded, saveState };
}
