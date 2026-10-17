"use client";

import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuActivity } from "react-icons/lu";
import { LoadingButton } from "@/components/loading-button";
import { AnimatedDisclosureContent } from "@/components/ui/animated-disclosure";
import { OperationFlow } from "@/components/ui/operation-flow";
import { SettingsPanel } from "@/components/ui/settings-panel";
import { translateBackendError } from "@/lib/backend-errors";
import { cn } from "@/lib/utils";

interface Diagnostic {
  configured: boolean;
  reachable: boolean | null;
  authorized: boolean | null;
  http_status: number | null;
  checked_at: number;
}

/**
 * The station a probe stopped at and why, or null when it passed all three.
 * A server that answers with neither success nor a refusal leaves the
 * credential unverified, which is not a pass.
 */
function stopOf(result: Diagnostic) {
  if (!result.configured) {
    return { station: 0, reason: "appFeedback.probeNotConfigured" } as const;
  }
  if (result.reachable === false) {
    return { station: 1, reason: "appFeedback.probeUnreachable" } as const;
  }
  if (result.authorized === false) {
    return { station: 2, reason: "appFeedback.probeRefused" } as const;
  }
  if (result.authorized == null) {
    return { station: 2, reason: "appFeedback.probeUnverified" } as const;
  }
  return null;
}

/**
 * A read-only probe of one integration route. The owner remounts it (via
 * `key`) whenever the credential or server it describes changes, so a receipt
 * never outlives the configuration it was taken against.
 *
 * Until the first test it is one row; the stations, the receipt and what
 * failed appear only once there is a result, and a failure stays until the
 * next test.
 */
export function IntegrationDiagnostics({
  target,
  className,
}: {
  target: "api" | "remote";
  className?: string;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<Diagnostic | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await invoke<Diagnostic>("check_integration_connection", { target }),
      );
    } catch (err) {
      // A receipt from an earlier test must not stand in for this one.
      setResult(null);
      setError(translateBackendError(t, err));
    } finally {
      setBusy(false);
    }
  };
  const verdict = (value: boolean | null | undefined) =>
    t(
      value == null
        ? "appFeedback.notVerified"
        : value
          ? "appFeedback.confirmed"
          : "appFeedback.unavailable",
    );
  const stop = result && !busy ? stopOf(result) : null;
  const problem =
    error ??
    (stop ? t(stop.reason, { status: result?.http_status ?? "" }) : null);

  return (
    <SettingsPanel
      data-slot="integration-diagnostics"
      className={cn("py-3", className)}
    >
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="text-sm font-medium">
            {t("appFeedback.connectionTest")}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(
              target === "api"
                ? "appFeedback.apiProbeScope"
                : "appFeedback.remoteProbeScope",
            )}
          </p>
        </div>
        <LoadingButton
          size="sm"
          variant="soft"
          className="h-8 shrink-0 gap-1.5 rounded-lg text-xs"
          isLoading={busy}
          onClick={() => void check()}
        >
          <LuActivity className="size-3.5" />
          {t("appFeedback.testConnection")}
        </LoadingButton>
      </div>
      <AnimatedDisclosureContent open={busy || result !== null || !!error}>
        <div className="mt-3 border-t border-foreground/6 pt-3">
          {(busy || result) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <OperationFlow
                compact
                label={t("appFeedback.connectionTest")}
                // Nothing is verified until this test answers.
                active={busy ? 0 : (stop?.station ?? 2)}
                busy={busy}
                failed={!!stop}
                steps={[
                  {
                    id: "configured",
                    label: t("appFeedback.configured"),
                    detail: verdict(busy ? null : result?.configured),
                  },
                  {
                    id: "reachable",
                    label: t("appFeedback.reachable"),
                    detail: verdict(busy ? null : result?.reachable),
                  },
                  {
                    id: "authorized",
                    label: t("appFeedback.authorized"),
                    detail: verdict(busy ? null : result?.authorized),
                  },
                ]}
              />
              <p
                role="status"
                className="ml-auto flex items-center gap-2 text-xs text-muted-foreground tabular-nums"
              >
                {busy
                  ? t("appFeedback.checking")
                  : result &&
                    t("proxyCheck.tooltipChecked", {
                      time: new Date(
                        result.checked_at * 1000,
                      ).toLocaleTimeString(),
                    })}
                {!busy && result?.http_status != null && (
                  <span className="rounded-md bg-foreground/5 px-1.5 py-0.5 font-mono">
                    HTTP {result.http_status}
                  </span>
                )}
              </p>
            </div>
          )}
          {problem && (
            <p
              role="alert"
              data-slot="integration-diagnostics-problem"
              className={cn(
                "break-words text-xs leading-relaxed text-destructive-text",
                (busy || result) && "mt-1.5",
              )}
            >
              {problem}
            </p>
          )}
        </div>
      </AnimatedDisclosureContent>
    </SettingsPanel>
  );
}
