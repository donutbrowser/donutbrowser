"use client";

import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

/** What the backend last measured about a running profile's route. */
export interface ProxyHealth {
  profile_id: string;
  /** "ok", "degraded" (slow or failing now and then) or "down". */
  status: "ok" | "degraded" | "down";
  /** A backend error code, never an English sentence. */
  code?: string;
  /** Unix seconds. */
  at: number;
}

/**
 * Route health per running profile, from the `proxy-health-changed` event.
 * A profile with no entry has not been measured, which is not a failure.
 */
export function useProxyHealth(): Map<string, ProxyHealth> {
  const [health, setHealth] = useState<Map<string, ProxyHealth>>(
    () => new Map(),
  );
  useEffect(() => {
    let disposed = false;
    const unlisten = listen<
      ProxyHealth | { profile_id: string; cleared: true }
    >("proxy-health-changed", (event) => {
      if (disposed) return;
      setHealth((current) => {
        const next = new Map(current);
        if ("cleared" in event.payload) {
          next.delete(event.payload.profile_id);
        } else {
          next.set(event.payload.profile_id, event.payload);
        }
        return next;
      });
    });
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);
  return health;
}
