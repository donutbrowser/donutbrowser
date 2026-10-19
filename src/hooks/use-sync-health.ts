"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { translateBackendError } from "@/lib/backend-errors";
import { notifySystem } from "@/lib/system-notify";
import { showToast } from "@/lib/toast-utils";

export type SyncHealthState = "idle" | "syncing" | "offline" | "error";

/** The whole of sync, from the `sync-health-changed` event. */
export interface SyncHealth {
  state: SyncHealthState;
  /** A backend error code when offline or failed. */
  code?: string;
  /** Unix seconds. */
  at: number;
}

/** A download replaced a local edit that never reached the cloud. */
export interface SyncConflict {
  entity: string;
  id: string;
  name?: string | null;
  kept: "remote" | "local";
  at: number;
}

/** The translated reason of a failed or offline state. */
export function syncHealthReason(
  t: Parameters<typeof translateBackendError>[0],
  health: SyncHealth,
): string | null {
  if (!health.code) return null;
  return translateBackendError(t, JSON.stringify({ code: health.code }));
}

/**
 * Sync health for the header, or null when sync is not set up. Also tells
 * the person about conflicts (a toast) and about a failure while the window
 * is in the background (a system notification).
 */
export function useSyncHealth(): SyncHealth | null {
  const { t } = useTranslation();
  const [health, setHealth] = useState<SyncHealth | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    let disposed = false;
    // An event that arrives while the first read is in flight is newer.
    let heard = false;

    void invoke<SyncHealth | null>("get_sync_health")
      .then((current) => {
        if (!disposed && !heard) setHealth(current);
      })
      .catch((error: unknown) => {
        console.warn("Failed to read sync health:", error);
      });

    const unlistenHealth = listen<SyncHealth>(
      "sync-health-changed",
      (event) => {
        if (disposed) return;
        heard = true;
        const next = event.payload;
        setHealth(next);
        if (next.state === "error") {
          const translate = tRef.current;
          void notifySystem({
            title: translate("syncHealth.notifyTitle"),
            body: syncHealthReason(translate, next) ?? undefined,
          });
        }
      },
    );

    const unlistenConflict = listen<SyncConflict>("sync-conflict", (event) => {
      if (disposed) return;
      const { entity, id, name } = event.payload;
      const translate = tRef.current;
      showToast({
        type: "info",
        id: `sync-conflict-${entity}-${id}`,
        title: name
          ? translate("syncHealth.conflictToast", { name })
          : translate("syncHealth.conflictToastUnnamed"),
      });
    });

    return () => {
      disposed = true;
      void unlistenHealth.then((stop) => stop());
      void unlistenConflict.then((stop) => stop());
    };
  }, []);

  return health;
}
