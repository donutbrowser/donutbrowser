"use client";

import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { LuCloud, LuCloudAlert, LuCloudOff, LuRefreshCw } from "react-icons/lu";
import {
  type SyncHealthState,
  syncHealthReason,
  useSyncHealth,
} from "@/hooks/use-sync-health";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Swap } from "./page-transition";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const ICONS: Record<
  SyncHealthState,
  ComponentType<{ className?: string; "aria-hidden"?: boolean }>
> = {
  idle: LuCloud,
  syncing: LuRefreshCw,
  offline: LuCloudOff,
  error: LuCloudAlert,
};

const TONES: Record<SyncHealthState, string> = {
  idle: "text-muted-foreground",
  syncing: "text-muted-foreground",
  offline: "text-warning",
  error: "text-destructive",
};

/**
 * Where sync stands, as one small icon in the header. Hidden when sync is
 * not set up. Spins only while a sync runs; a change of state crossfades.
 */
export function SyncHealthIndicator() {
  const { t } = useTranslation();
  const health = useSyncHealth();
  if (!health) return null;

  const Icon = ICONS[health.state];
  const reason = syncHealthReason(t, health);
  const label =
    health.state === "error"
      ? reason
        ? t("syncHealth.errorWith", { error: reason })
        : t("syncHealth.error")
      : t(`syncHealth.${health.state}`);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-label={label}
          data-slot="sync-health"
          data-state={health.state}
          className={cn(
            "relative grid size-7 shrink-0 place-items-center rounded-md",
            TONES[health.state],
          )}
        >
          <Swap
            swapKey={health.state}
            as="span"
            from={{ opacity: 0.5, scale: 0.8 }}
            transition={{
              duration: MOTION_DURATION.base,
              ease: MOTION_EASE_OUT,
            }}
            className="grid place-items-center"
          >
            <Icon
              aria-hidden={true}
              className={cn(
                "size-3.5",
                health.state === "syncing" && "motion-safe:animate-spin",
              )}
            />
          </Swap>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{label}</p>
        {health.state === "offline" && reason ? (
          <p className="text-primary-foreground/75">{reason}</p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
