"use client";

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingButton } from "@/components/loading-button";
import { SegmentedControl } from "@/components/settings/settings-primitives";
import { AnimatedDisclosureContent } from "@/components/ui/animated-disclosure";
import { Button } from "@/components/ui/button";
import { SoftFields } from "@/components/ui/field-variant";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusLight } from "@/components/ui/settings-panel";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { SyncServerCheck, SyncSourceKind, SyncSourceState } from "@/types";

type Probe =
  | { state: "unknown" | "testing" | "unreachable" | "no-accounts" }
  | { state: "ready" }
  | { state: "mismatch"; address: string };

/** A quick check before saving. The backend compares the exact form. */
function sameAddress(a: string, b: string): boolean {
  const trim = (value: string) =>
    value.trim().replace(/\/+$/, "").toLowerCase();
  return trim(a) === trim(b);
}

function hostOf(server: string): string {
  try {
    return new URL(server).host || server;
  } catch {
    return server;
  }
}

/**
 * Where a signed-in account syncs, as one line of the account card. Several
 * stored servers make it a choice; on a paid plan, Change opens the address
 * of the account's own server.
 */
export function AccountSyncServer({
  paid,
  teamSeat,
}: {
  paid: boolean;
  teamSeat: boolean;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [source, setSource] = useState<SyncSourceState | null>(null);
  const [editing, setEditing] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [probe, setProbe] = useState<Probe>({ state: "unknown" });
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);

  useEffect(() => {
    void invoke<SyncSourceState>("get_sync_source")
      .then((state) => {
        setSource(state);
        setServerUrl(state.account_server ?? "");
      })
      .catch((error: unknown) => {
        console.error("Failed to load the sync source:", error);
      });
  }, []);

  const restartSync = useCallback(async () => {
    try {
      await invoke("restart_sync_service");
    } catch (e) {
      console.error("Failed to restart sync service:", e);
    }
  }, []);

  const accountHost = source?.account_server
    ? hostOf(source.account_server)
    : null;
  const selfHostedHost = source?.self_hosted_server
    ? hostOf(source.self_hosted_server)
    : null;
  const showAccount =
    accountHost !== null && (paid || source?.active === "account");
  const options: { value: SyncSourceKind; label: string }[] = [
    { value: "cloud", label: t("account.ownServer.donutCloud") },
  ];
  if (showAccount && accountHost) {
    options.push({ value: "account", label: accountHost });
  }
  if (selfHostedHost && !teamSeat) {
    options.push({
      value: "self_hosted",
      label:
        showAccount && selfHostedHost === accountHost
          ? t("account.ownServer.tokenServer", { host: selfHostedHost })
          : selfHostedHost,
    });
  }
  const labelOf = (kind: SyncSourceKind) =>
    options.find((option) => option.value === kind)?.label ?? "";

  const choose = useCallback(
    async (next: SyncSourceKind, label: string) => {
      if (!source) return;
      const previous = source;
      setSource({ ...source, active: next });
      try {
        setSource(
          await invoke<SyncSourceState>("set_sync_source", { source: next }),
        );
        await restartSync();
        showSuccessToast(
          next === "cloud"
            ? t("account.ownServer.backToCloud")
            : t("account.ownServer.switched", { server: label }),
        );
      } catch (error) {
        setSource(previous);
        showErrorToast(translateBackendError(t as never, error));
      }
    },
    [source, restartSync, t],
  );

  const handleTest = useCallback(async () => {
    setProbe({ state: "testing" });
    try {
      const result = await invoke<SyncServerCheck>(
        "check_sync_server_connection",
        { serverUrl },
      );
      if (
        !result.server_reachable ||
        result.storage_ready === false ||
        result.storage_reachable === false
      ) {
        setProbe({ state: "unreachable" });
      } else if (!result.account_url) {
        setProbe({ state: "no-accounts" });
      } else if (!sameAddress(result.account_url, serverUrl)) {
        setProbe({ state: "mismatch", address: result.account_url });
      } else {
        setProbe({ state: "ready" });
      }
    } catch {
      setProbe({ state: "unreachable" });
    }
  }, [serverUrl]);

  const store = useCallback(
    async (next: string | null) => {
      const wasActive = source?.active === "account";
      setBusy(next ? "save" : "remove");
      try {
        const state = await invoke<SyncSourceState>("set_account_sync_server", {
          serverUrl: next,
        });
        setSource(state);
        setServerUrl(state.account_server ?? "");
        setProbe({ state: "unknown" });
        setEditing(false);
        if (state.account_server) {
          await restartSync();
          showSuccessToast(
            t("account.ownServer.switched", {
              server: hostOf(state.account_server),
            }),
          );
        } else if (wasActive) {
          await restartSync();
          showSuccessToast(t("account.ownServer.backToCloud"));
        } else {
          showSuccessToast(t("account.ownServer.removed"));
        }
      } catch (error) {
        showErrorToast(translateBackendError(t as never, error));
      } finally {
        setBusy(null);
      }
    },
    [source, restartSync, t],
  );

  if (!source || (!paid && options.length < 2)) return null;

  const active = source.active ?? "cloud";
  const probeTone = {
    unknown: "muted",
    testing: "muted",
    ready: "success",
    unreachable: "destructive",
    "no-accounts": "destructive",
    mismatch: "destructive",
  } as const;
  const probeLabel =
    probe.state === "mismatch"
      ? t("backendErrors.syncServerAddressMismatch", { address: probe.address })
      : {
          unknown: t("account.selfHosted.statusUnknown"),
          testing: t("appFeedback.checking"),
          ready: t("account.ownServer.accountsOn"),
          unreachable: t("backendErrors.syncServerUnreachable"),
          "no-accounts": t("backendErrors.syncServerNoAccounts"),
        }[probe.state];

  return (
    <div
      data-slot="account-sync-source"
      className="flex flex-col gap-3 border-t border-foreground/6 pt-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-xs text-muted-foreground">
          {t("account.ownServer.label")}
        </span>
        {options.length > 1 ? (
          <SegmentedControl
            value={active}
            onValueChange={(next) => void choose(next, labelOf(next))}
            options={options}
            label={t("account.ownServer.label")}
            slot="account-sync-source-choice"
          />
        ) : (
          <span className="text-xs font-medium">{options[0].label}</span>
        )}
        {paid && (
          <Button
            type="button"
            size="sm"
            variant="subtle"
            aria-expanded={editing}
            aria-controls={formId}
            onClick={() => {
              setEditing((open) => !open);
            }}
            className="ml-auto h-7 rounded-lg px-2 text-xs"
          >
            {t("account.ownServer.change")}
          </Button>
        )}
      </div>

      {(editing || active !== "cloud") && (
        <p className="text-xs text-muted-foreground">
          {t("account.ownServer.cloudOnly")}
        </p>
      )}

      <AnimatedDisclosureContent open={editing && paid}>
        <div id={formId} className="flex flex-col gap-3">
          <SoftFields>
            <div className="space-y-1.5">
              <Label
                htmlFor="account-sync-server-url"
                className="text-xs font-medium text-muted-foreground"
              >
                {t("sync.serverUrl")}
              </Label>
              <Input
                id="account-sync-server-url"
                type="url"
                placeholder={t("sync.serverUrlPlaceholder")}
                value={serverUrl}
                onChange={(e) => {
                  setServerUrl(e.target.value);
                  setProbe({ state: "unknown" });
                }}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </SoftFields>

          {teamSeat && (
            <p className="text-xs text-muted-foreground">
              {t("account.ownServer.teamNote")}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <span
              role="status"
              className="mr-auto inline-flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
            >
              <StatusLight
                tone={probeTone[probe.state]}
                live={probe.state === "testing" || probe.state === "ready"}
              />
              <span className="min-w-0 font-medium text-foreground">
                {probeLabel}
              </span>
            </span>
            {source.account_server && (
              <Button
                type="button"
                size="sm"
                variant="subtle"
                disabled={busy !== null}
                aria-busy={busy === "remove"}
                onClick={() => void store(null)}
                className="h-8 rounded-lg text-xs hover:bg-destructive/10 hover:text-destructive-text"
              >
                {t("account.ownServer.remove")}
              </Button>
            )}
            <LoadingButton
              size="sm"
              variant="soft"
              isLoading={probe.state === "testing"}
              disabled={!serverUrl.trim() || busy !== null}
              onClick={() => void handleTest()}
              className="h-8 rounded-lg text-xs"
            >
              {t("account.selfHosted.testConnection")}
            </LoadingButton>
            <LoadingButton
              size="sm"
              isLoading={busy === "save"}
              disabled={
                !serverUrl.trim() ||
                busy !== null ||
                probe.state === "testing" ||
                (source.account_server !== null &&
                  sameAddress(source.account_server, serverUrl))
              }
              onClick={() => void store(serverUrl)}
              className="h-8 rounded-lg text-xs"
            >
              {t("common.buttons.save")}
            </LoadingButton>
          </div>
        </div>
      </AnimatedDisclosureContent>
    </div>
  );
}
