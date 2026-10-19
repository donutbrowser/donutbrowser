"use client";

import { invoke } from "@tauri-apps/api/core";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { BandwidthMiniChart } from "@/components/bandwidth-mini-chart";
import {
  TRAFFIC_POLL_MS,
  type TrafficSnapshotStore,
} from "@/components/profile-table/traffic-snapshots";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import type { ProxyHealth } from "@/hooks/use-proxy-health";
import { translateBackendError } from "@/lib/backend-errors";
import { MOTION_EASE_OUT, MOTION_SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { TrafficSnapshot } from "@/types";

function formatBandwidth(bytes: number): string {
  if (bytes <= 0) return "0 B/s";
  if (bytes < 1024) return `${bytes} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
}

/**
 * Reads the running profiles' traffic into `store`: every two seconds while
 * the window shows, and at once when it comes back or the running set
 * changes. Nothing runs while no profile does.
 */
export function useTrafficPolling(
  store: TrafficSnapshotStore,
  runningIds: readonly string[],
  enabled: boolean,
) {
  const runningKey = runningIds.join(",");
  React.useEffect(() => {
    if (!enabled) return;
    const running = new Set(runningKey ? runningKey.split(",") : []);
    store.retain(running);
    if (running.size === 0) return;
    let disposed = false;
    let busy = false;
    const poll = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const snapshots = await invoke<TrafficSnapshot[]>(
          "get_all_traffic_snapshots",
        );
        if (!disposed) store.update(snapshots, running);
      } catch (error) {
        console.error("Failed to fetch traffic snapshots:", error);
      } finally {
        busy = false;
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), TRAFFIC_POLL_MS);
    const onVisibility = () => void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, runningKey, store]);
}

/** One profile's snapshot; re-renders only when that snapshot changes. */
function useTrafficSnapshot(store: TrafficSnapshotStore, profileId: string) {
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribe(profileId, listener),
    [store, profileId],
  );
  const read = React.useCallback(
    () => store.get(profileId),
    [store, profileId],
  );
  return React.useSyncExternalStore(subscribe, read, read);
}

/** The figure counts to each new value instead of jumping to it. */
function CountingBandwidth({ value }: { value: number }) {
  const motionAllowed = useMotionAllowed();
  const shown = useMotionValue(value);
  const text = useTransform(shown, (current) =>
    formatBandwidth(Math.round(current)),
  );
  React.useEffect(() => {
    if (!motionAllowed) {
      shown.set(value);
      return;
    }
    const controls = animate(shown, value, {
      duration: 0.3,
      ease: MOTION_EASE_OUT,
    });
    return () => controls.stop();
  }, [value, motionAllowed, shown]);
  return (
    <motion.span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs whitespace-nowrap text-muted-foreground tabular-nums"
    >
      {text}
    </motion.span>
  );
}

/** What a health entry means, in the person's language. */
export function proxyHealthLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  health: ProxyHealth,
): string {
  if (health.code) {
    return translateBackendError(
      t as never,
      JSON.stringify({ code: health.code }),
    );
  }
  return t(`profileTable.health.${health.status}`);
}

/** A warning or destructive mark for a route that is slow or down. */
function HealthDot({ health }: { health: ProxyHealth }) {
  const motionAllowed = useMotionAllowed();
  return (
    <motion.span
      aria-hidden="true"
      data-slot="proxy-health-dot"
      data-health={health.status}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        health.status === "down" ? "bg-destructive" : "bg-warning",
      )}
      initial={motionAllowed ? { scale: 0 } : false}
      animate={{ scale: 1 }}
      transition={MOTION_SPRING.snappy}
    />
  );
}

/**
 * A running row's proxy cell: the route's live traffic, the route name in
 * the tooltip, and a mark when the route is slow or down. The chart keeps
 * one instance per row, so it never remounts on a traffic tick.
 */
export function RunningTrafficCell({
  profileId,
  profileName,
  store,
  routeName,
  health,
  onOpen,
}: {
  profileId: string;
  profileName: string;
  store: TrafficSnapshotStore;
  routeName: string | null;
  health: ProxyHealth | undefined;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  // The store keeps a snapshot's object while it does not change.
  const snapshot = useTrafficSnapshot(store, profileId);
  const data = React.useMemo(
    () => (snapshot?.recent_bandwidth ? [...snapshot.recent_bandwidth] : []),
    [snapshot],
  );
  const current =
    (snapshot?.current_bytes_sent ?? 0) +
    (snapshot?.current_bytes_received ?? 0);
  const unhealthy = health && health.status !== "ok" ? health : undefined;
  const healthText = unhealthy ? proxyHealthLabel(t, unhealthy) : null;
  const route = routeName
    ? t("profileTable.route", { name: routeName })
    : t("profileTable.routeNone");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          data-slot="profile-traffic-cell"
          className="relative flex min-w-0 items-center gap-1 overflow-hidden"
        >
          {unhealthy && <HealthDot health={unhealthy} />}
          <div className="relative min-w-0 flex-1">
            <BandwidthMiniChart
              data={data}
              currentBandwidth={current}
              onClick={onOpen}
              aria-label={t("profileTable.aria.traffic", {
                name: profileName,
              })}
              className="[&>span]:text-transparent"
            />
            <CountingBandwidth value={current} />
          </div>
          {healthText && (
            <span className="sr-only">
              {t("profileTable.aria.health", {
                name: profileName,
                status: healthText,
              })}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <p>{route}</p>
        {healthText && <p className="mt-0.5 opacity-80">{healthText}</p>}
      </TooltipContent>
    </Tooltip>
  );
}
