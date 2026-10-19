"use client";

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuEye, LuEyeOff } from "react-icons/lu";
import { LoadingButton } from "@/components/loading-button";
import {
  AnimatedTabs,
  AnimatedTabsContent,
  AnimatedTabsList,
  AnimatedTabsTrigger,
} from "@/components/ui/animated-tabs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProBadge } from "@/components/ui/pro-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCloudAuth } from "@/hooks/use-cloud-auth";
import { translateBackendError } from "@/lib/backend-errors";
import { effectivePlanOf } from "@/lib/entitlements";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { SyncServerCheck, SyncSettings, SyncSourceState } from "@/types";

const DEVICE_LINK_URL = "https://donutbrowser.com/auth/link";

interface SyncConfigDialogProps {
  isOpen: boolean;
  onClose: (loginOccurred?: boolean) => void;
  /**
   * Called after the user clicks "Login" so the parent can open the
   * device-code verify dialog as a separate step. Implementations should
   * close this dialog and open the verify one — that keeps the verify
   * step visually independent and avoids stacking on top of other
   * dialogs (e.g. the profile selector triggered by deep links).
   */
  onLoginStarted?: () => void;
}

interface ProxyUsage {
  used_mb: number;
  limit_mb: number;
  remaining_mb: number;
  recurring_limit_mb: number;
  extra_limit_mb: number;
}

export function SyncConfigDialog({
  isOpen,
  onClose,
  onLoginStarted,
}: SyncConfigDialogProps) {
  const { t } = useTranslation();

  // Self-hosted state
  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [showToken, setShowToken] = useState(false);

  // Cloud auth state
  const {
    user,
    isLoggedIn,
    isLoading: isCloudLoading,
    logout,
  } = useCloudAuth();

  const [activeTab, setActiveTab] = useState<string>("cloud");
  const [syncSource, setSyncSource] = useState<SyncSourceState | null>(null);
  const [, setLiveProxyUsage] = useState<ProxyUsage | null>(null);

  const [connectionStatus, setConnectionStatus] = useState<
    "unknown" | "testing" | "connected" | "error" | "storage-unreachable"
  >("unknown");
  const [storageEndpoint, setStorageEndpoint] = useState<string | null>(null);
  const hasConfig = Boolean(serverUrl && token);

  // Probing the sync server alone is what let a broken setup look correct.
  // Files never travel through that server: the client is handed a presigned
  // URL and uploads straight to storage, so a server whose storage address is
  // reachable only from its own network answers every probe while every single
  // transfer fails at connect. The check runs in the backend because that is
  // the client that performs the transfers — same DNS, proxy and TLS trust, so
  // a setup that passes here can actually move bytes.
  const probeServer = useCallback(
    (url: string) =>
      invoke<SyncServerCheck>("check_sync_server_connection", {
        serverUrl: url,
      }),
    [],
  );

  const applyProbeResult = useCallback((result: SyncServerCheck) => {
    setStorageEndpoint(result.storage_endpoint ?? null);
    if (!result.server_reachable || result.storage_ready === false) {
      setConnectionStatus("error");
      return "error" as const;
    }
    if (result.storage_reachable === false) {
      setConnectionStatus("storage-unreachable");
      return "storage-unreachable" as const;
    }
    setConnectionStatus("connected");
    return "connected" as const;
  }, []);

  const testConnection = useCallback(
    async (url: string) => {
      setConnectionStatus("testing");
      try {
        applyProbeResult(await probeServer(url));
      } catch {
        setStorageEndpoint(null);
        setConnectionStatus("error");
      }
    },
    [probeServer, applyProbeResult],
  );

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      const settings = await invoke<SyncSettings>("get_sync_settings");
      setServerUrl(settings.sync_server_url ?? "");
      setToken(settings.sync_token ?? "");
      if (settings.sync_server_url && settings.sync_token) {
        void testConnection(settings.sync_server_url);
      }
    } catch (error) {
      console.error("Failed to load sync settings:", error);
    } finally {
      setIsLoading(false);
    }
  }, [testConnection]);

  useEffect(() => {
    if (isOpen) {
      setConnectionStatus("unknown");
      void loadSettings();
      void invoke<SyncSourceState>("get_sync_source")
        .then(setSyncSource)
        .catch(() => {
          setSyncSource(null);
        });
      void invoke<ProxyUsage | null>("cloud_get_proxy_usage")
        .then(setLiveProxyUsage)
        .catch(() => {
          setLiveProxyUsage(null);
        });
    }
  }, [isOpen, loadSettings]);

  // Auto-select the appropriate tab based on connection state
  useEffect(() => {
    if (isCloudLoading) return;
    if (isLoggedIn) {
      setActiveTab("cloud");
    } else if (serverUrl && token) {
      setActiveTab("self-hosted");
    } else {
      setActiveTab("cloud");
    }
  }, [isCloudLoading, isLoggedIn, serverUrl, token]);

  const handleTestConnection = useCallback(async () => {
    if (!serverUrl) {
      showErrorToast(t("sync.config.serverUrlRequired"));
      return;
    }

    setIsTesting(true);
    setConnectionStatus("testing");
    try {
      const result = await probeServer(serverUrl);
      const outcome = applyProbeResult(result);
      if (outcome === "connected") {
        showSuccessToast(t("sync.config.connectionSuccess"));
      } else if (outcome === "storage-unreachable") {
        // Deliberately an error, not a warning. Nothing will sync in this
        // state, and reporting it as success is the bug being fixed.
        showErrorToast(
          t("sync.config.storageUnreachable", {
            endpoint: result.storage_endpoint ?? "",
          }),
        );
      } else {
        showErrorToast(t("sync.config.serverError"));
      }
    } catch {
      setStorageEndpoint(null);
      setConnectionStatus("error");
      showErrorToast(t("sync.config.connectFailed"));
    } finally {
      setIsTesting(false);
    }
  }, [serverUrl, t, probeServer, applyProbeResult]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await invoke<SyncSettings>("save_sync_settings", {
        syncServerUrl: serverUrl || null,
        syncToken: token || null,
      });
      try {
        await invoke("restart_sync_service");
      } catch (e) {
        console.error("Failed to restart sync service:", e);
      }
      showSuccessToast(t("sync.config.settingsSaved"));
      onClose();
    } catch (error) {
      console.error("Failed to save sync settings:", error);
      showErrorToast(t("sync.config.saveFailed"), {
        description: translateBackendError(t, error),
      });
    } finally {
      setIsSaving(false);
    }
  }, [serverUrl, token, onClose, t]);

  const handleDisconnect = useCallback(async () => {
    setIsSaving(true);
    try {
      await invoke<SyncSettings>("save_sync_settings", {
        syncServerUrl: null,
        syncToken: null,
      });
      try {
        await invoke("restart_sync_service");
      } catch (e) {
        console.error("Failed to restart sync service:", e);
      }
      setServerUrl("");
      setToken("");
      setConnectionStatus("unknown");
      showSuccessToast(t("sync.config.disconnected"));
    } catch (error) {
      console.error("Failed to disconnect:", error);
      showErrorToast(t("sync.config.disconnectFailed"), {
        description: translateBackendError(t, error),
      });
    } finally {
      setIsSaving(false);
    }
  }, [t]);

  const handleOpenLogin = useCallback(async () => {
    try {
      await openUrl(DEVICE_LINK_URL);
      // Hand off the verify step to its own dialog so the user has a
      // focused place to paste the code, and so it doesn't visually
      // stack with this dialog or any other modal currently on screen.
      onLoginStarted?.();
    } catch (error) {
      console.error("Failed to open login link:", error);
      showErrorToast(translateBackendError(t, error));
    }
  }, [onLoginStarted, t]);

  const handleCloudLogout = useCallback(async () => {
    try {
      await logout();
      showSuccessToast(t("sync.cloud.logoutSuccess"));
      setServerUrl("");
      setToken("");
      try {
        await invoke("restart_sync_service");
      } catch (e) {
        console.error("Failed to restart sync service:", e);
      }
    } catch (error) {
      console.error("Failed to logout:", error);
      showErrorToast(translateBackendError(t, error));
    }
  }, [logout, t]);

  const cloudBlocked = !isLoggedIn && hasConfig;
  const selfHostedBlocked = isLoggedIn;
  const activeSource = syncSource?.active ?? "cloud";
  const syncServer =
    activeSource === "account"
      ? syncSource?.account_server
      : activeSource === "self_hosted"
        ? syncSource?.self_hosted_server
        : null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("sync.title")}</DialogTitle>
          <DialogDescription>{t("sync.description")}</DialogDescription>
        </DialogHeader>

        {isLoggedIn && user ? (
          <div className="grid gap-4 py-4">
            <div className="flex items-center gap-2 text-sm">
              <div className="size-2 rounded-full bg-success" />
              {t("sync.cloud.connected")}
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {t("sync.cloud.email")}
                </span>
                <span>{user.email}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {t("sync.cloud.plan")}
                </span>
                <span className="capitalize">
                  {effectivePlanOf(user)}
                  {user.planPeriod ? ` (${user.planPeriod})` : ""}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("sync.cloud.server")}
                </span>
                <span className="truncate">
                  {syncServer ?? t("account.ownServer.donutCloud")}
                </span>
              </div>
              {activeSource === "cloud" && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t("sync.cloud.profiles")}
                  </span>
                  <span>
                    {t("sync.cloud.profileUsage", {
                      used: user.cloudProfilesUsed,
                      limit: user.profileLimit,
                    })}
                  </span>
                </div>
              )}
              {user.teamName && (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      {t("sync.team.name")}
                    </span>
                    <span>{user.teamName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      {t("sync.team.role")}
                    </span>
                    <span className="capitalize">
                      {user.teamRole === "owner"
                        ? t("sync.team.roleOwner")
                        : user.teamRole === "admin"
                          ? t("sync.team.roleAdmin")
                          : user.teamRole === "launcher"
                            ? t("sync.team.roleLauncher")
                            : t("sync.team.roleMember")}
                    </span>
                  </div>
                  <p className="pt-1 text-xs text-muted-foreground">
                    {t("sync.team.manageOnWeb")}
                  </p>
                </>
              )}
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1" asChild>
                <a
                  href="https://donutbrowser.com/account"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("sync.cloud.manageAccount")}
                </a>
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => void handleCloudLogout()}
              >
                {t("sync.cloud.logout")}
              </Button>
            </div>
          </div>
        ) : (
          <AnimatedTabs value={activeTab} onValueChange={setActiveTab}>
            <AnimatedTabsList className="flex w-full">
              <AnimatedTabsTrigger
                value="cloud"
                className="flex-1"
                disabled={cloudBlocked}
              >
                <span className="flex items-center gap-2">
                  {t("sync.cloud.tabLabel")}
                  {cloudBlocked && <ProBadge />}
                </span>
              </AnimatedTabsTrigger>
              <AnimatedTabsTrigger
                value="self-hosted"
                className="flex-1"
                disabled={selfHostedBlocked}
              >
                <span className="flex items-center gap-2">
                  {t("sync.cloud.selfHostedTabLabel")}
                  {selfHostedBlocked && <ProBadge />}
                </span>
              </AnimatedTabsTrigger>
            </AnimatedTabsList>

            <AnimatedTabsContent value="cloud">
              {isCloudLoading ? (
                <div className="flex justify-center py-8">
                  <div className="size-6 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
                </div>
              ) : (
                <div className="grid gap-4 py-4">
                  <p className="text-sm text-muted-foreground">
                    {t("sync.cloud.deviceLinkInstructions")}
                  </p>
                  <Button
                    onClick={() => void handleOpenLogin()}
                    className="w-full"
                  >
                    {t("sync.cloud.openLogin")}
                  </Button>
                </div>
              )}
            </AnimatedTabsContent>

            <AnimatedTabsContent value="self-hosted">
              {isLoading ? (
                <div className="flex justify-center py-8">
                  <div className="size-6 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
                </div>
              ) : (
                <div className="grid gap-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="sync-server-url">
                      {t("sync.serverUrl")}
                    </Label>
                    <Input
                      id="sync-server-url"
                      placeholder={t("sync.serverUrlPlaceholder")}
                      value={serverUrl}
                      onChange={(e) => {
                        setServerUrl(e.target.value);
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="sync-token">{t("sync.token")}</Label>
                    <div className="relative">
                      <Input
                        id="sync-token"
                        type={showToken ? "text" : "password"}
                        placeholder={t("sync.tokenPlaceholder")}
                        value={token}
                        onChange={(e) => {
                          setToken(e.target.value);
                        }}
                        className="pr-10"
                      />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => {
                              setShowToken(!showToken);
                            }}
                            className={cn(
                              "absolute top-1/2 right-3 -translate-y-1/2 transform rounded-sm p-1 transition-colors hover:bg-foreground/5 hover:text-foreground",
                              FOCUS_RING,
                            )}
                            aria-label={
                              showToken
                                ? t("common.aria.hideToken")
                                : t("common.aria.showToken")
                            }
                          >
                            {showToken ? (
                              <LuEyeOff className="size-4 text-muted-foreground hover:text-foreground" />
                            ) : (
                              <LuEye className="size-4 text-muted-foreground hover:text-foreground" />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {showToken
                            ? t("common.aria.hideToken")
                            : t("common.aria.showToken")}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>

                  {connectionStatus === "testing" && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <div className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
                      {t("sync.status.syncing")}
                    </div>
                  )}
                  {connectionStatus === "connected" && (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <div className="size-2 rounded-full bg-success" />
                        {t("sync.status.connected")}
                      </div>
                      {storageEndpoint && (
                        <span className="text-xs text-muted-foreground break-all">
                          {t("sync.config.storageEndpoint", {
                            endpoint: storageEndpoint,
                          })}
                        </span>
                      )}
                    </div>
                  )}
                  {connectionStatus === "storage-unreachable" && (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <div className="size-2 rounded-full bg-destructive" />
                        {t("sync.config.storageUnreachableStatus")}
                      </div>
                      <span className="text-xs text-muted-foreground break-all">
                        {t("sync.config.storageUnreachable", {
                          endpoint: storageEndpoint ?? "",
                        })}
                      </span>
                    </div>
                  )}
                  {connectionStatus === "error" && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <div className="size-2 rounded-full bg-destructive" />
                      {t("sync.status.disconnected")}
                    </div>
                  )}
                </div>
              )}

              <DialogFooter className="flex gap-2">
                {hasConfig && (
                  <Button
                    variant="outline"
                    onClick={() => void handleDisconnect()}
                    disabled={isSaving}
                  >
                    {t("account.selfHosted.disconnect")}
                  </Button>
                )}
                <LoadingButton
                  variant="outline"
                  onClick={() => void handleTestConnection()}
                  isLoading={isTesting}
                  disabled={!serverUrl}
                >
                  {t("account.selfHosted.testConnection")}
                </LoadingButton>
                <LoadingButton
                  onClick={() => void handleSave()}
                  isLoading={isSaving}
                  disabled={!serverUrl || !token}
                >
                  {t("common.buttons.save")}
                </LoadingButton>
              </DialogFooter>
            </AnimatedTabsContent>
          </AnimatedTabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
