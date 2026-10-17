"use client";

import { invoke } from "@tauri-apps/api/core";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuCircleDashed, LuX } from "react-icons/lu";
import {
  CheckPill,
  CheckSpinner,
  type CheckState,
} from "@/components/entity-page";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { translateBackendError } from "@/lib/backend-errors";
import { formatRelativeTime } from "@/lib/flag-utils";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { ProxyCheckResult, VpnConfig } from "@/types";

interface VpnCheckEntry {
  /** The config the result belongs to; any other config shows no result. */
  routeKey: string;
  checking: boolean;
  result: ProxyCheckResult | null;
}

const IDLE: VpnCheckEntry = { routeKey: "", checking: false, result: null };

/** The last check of each VPN this session, so a row that remounts keeps it. */
const entries = new Map<string, VpnCheckEntry>();
const listeners = new Set<() => void>();

/** An edit, a synced download or an API update bumps `updated_at`, so a
 * result from before it no longer describes the tunnel. */
function vpnRouteKey(vpn: VpnConfig): string {
  return JSON.stringify([
    vpn.id,
    vpn.vpn_type,
    vpn.updated_at ?? null,
    vpn.config_data,
  ]);
}

function publish(vpnId: string, entry: VpnCheckEntry) {
  entries.set(vpnId, entry);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

interface VpnCheckButtonProps {
  vpn: VpnConfig;
  disabled?: boolean;
}

export function VpnCheckButton({ vpn, disabled = false }: VpnCheckButtonProps) {
  const { t } = useTranslation();
  const vpnId = vpn.id;
  const vpnName = vpn.name;
  const routeKey = vpnRouteKey(vpn);
  const getSnapshot = React.useCallback(
    () => entries.get(vpnId) ?? IDLE,
    [vpnId],
  );
  const raw = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { checking, result } = raw.routeKey === routeKey ? raw : IDLE;

  const handleCheck = React.useCallback(async () => {
    const current = entries.get(vpnId);
    const before =
      current?.routeKey === routeKey ? current : { ...IDLE, routeKey };
    if (before.checking) return;
    publish(vpnId, { ...before, checking: true });
    try {
      const checked = await invoke<ProxyCheckResult>("check_vpn_validity", {
        vpnId,
      });
      publish(vpnId, { routeKey, checking: false, result: checked });
      if (checked.is_valid) {
        showSuccessToast(t("vpnCheck.valid", { name: vpnName }));
      } else {
        showErrorToast(t("vpnCheck.invalid", { name: vpnName }));
      }
    } catch (error) {
      publish(vpnId, {
        routeKey,
        checking: false,
        result: {
          ip: "",
          timestamp: Math.floor(Date.now() / 1000),
          is_valid: false,
        },
      });
      showErrorToast(
        t("vpnCheck.failed", { error: translateBackendError(t, error) }),
      );
    }
  }, [vpnId, vpnName, routeKey, t]);

  const state: CheckState = checking
    ? "checking"
    : !result
      ? "idle"
      : result.is_valid
        ? "ok"
        : "failed";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <CheckPill
          state={state}
          resultKey={result?.timestamp}
          compact
          onClick={() => void handleCheck()}
          disabled={disabled}
          aria-busy={checking}
          aria-label={t(
            checking ? "vpnCheck.tooltipChecking" : "vpnCheck.tooltipDefault",
          )}
          icon={
            state === "checking" ? (
              <CheckSpinner />
            ) : state === "ok" ? (
              <LuCheck className="text-success-text" />
            ) : state === "failed" ? (
              <LuX />
            ) : (
              <LuCircleDashed />
            )
          }
        >
          {state === "checking"
            ? t("appFeedback.checking")
            : state === "ok"
              ? t("entities.check.valid")
              : state === "failed"
                ? t("entities.check.invalid")
                : t("entities.check.notChecked")}
        </CheckPill>
      </TooltipTrigger>
      <TooltipContent>
        {checking ? (
          <p>{t("vpnCheck.tooltipChecking")}</p>
        ) : result ? (
          <div className="space-y-1">
            <p>
              {t(
                result.is_valid
                  ? "vpnCheck.tooltipValid"
                  : "vpnCheck.tooltipInvalid",
              )}
            </p>
            <p className="text-primary-foreground/75">
              {t("vpnCheck.tooltipChecked", {
                time: formatRelativeTime(result.timestamp),
              })}
            </p>
          </div>
        ) : (
          <p>{t("vpnCheck.tooltipDefault")}</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
