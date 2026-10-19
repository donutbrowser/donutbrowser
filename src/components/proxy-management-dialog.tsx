"use client";

import { type RowSelectionState } from "@tanstack/react-table";
import {
  type LegacyColumnDef as ColumnDef,
  getCoreRowModel,
  getSortedRowModel,
  useLegacyTable as useReactTable,
} from "@tanstack/react-table/legacy";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuActivity,
  LuDownload,
  LuLock,
  LuPencil,
  LuPlus,
  LuRefreshCcwDot,
  LuRefreshCw,
  LuTrash2,
  LuUpload,
} from "react-icons/lu";
import { toast } from "sonner";
import {
  DataTableActionBar,
  DataTableActionBarAction,
  DataTableActionBarSelection,
} from "@/components/data-table-action-bar";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import {
  EntityEmptyState,
  VpnTunnelScene,
} from "@/components/entity-empty-state";
import {
  KindBadge,
  PageAction,
  RowAction,
  RowActions,
  SyncCell,
  type SyncStatus,
  TickingCount,
} from "@/components/entity-page";
import {
  configureEntityColumns,
  ManagedDataTable,
  useEntityTableTools,
} from "@/components/managed-data-table";
import { ProfileUsageButton } from "@/components/profile-usage-button";
import { ProxyExportDialog } from "@/components/proxy-export-dialog";
import { ProxyFormDialog } from "@/components/proxy-form-dialog";
import { ProxyImportDialog } from "@/components/proxy-import-dialog";
import { SortableColumnHeader } from "@/components/table-controls";
import { ProxyRouteScene } from "@/components/tips/scenes-essentials";
import {
  AnimatedTabs,
  AnimatedTabsContent,
  AnimatedTabsList,
  AnimatedTabsTrigger,
} from "@/components/ui/animated-tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfileReferences } from "@/hooks/use-profile-references";
import { useProxyEvents } from "@/hooks/use-proxy-events";
import { useEntityTrash } from "@/hooks/use-trash-events";
import { useVpnEvents } from "@/hooks/use-vpn-events";
import { parseBackendError, translateBackendError } from "@/lib/backend-errors";
import { runProxyCheck } from "@/lib/proxy-check-store";
import { rotateProxyIps } from "@/lib/proxy-rotation";
import { isFirstHopEncrypted, proxyProtocolToken } from "@/lib/proxy-string";
import { canonicalProxyType, proxyTypeLabelKey } from "@/lib/proxy-type";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { StoredProxy, VpnConfig } from "@/types";
import { ProxyCheckButton, ProxyUdpBadge } from "./proxy-check-button";
import { RippleButton } from "./ui/ripple";
import { VpnCheckButton } from "./vpn-check-button";
import { VpnFormDialog } from "./vpn-form-dialog";
import { VpnImportDialog } from "./vpn-import-dialog";

interface ProxyManagementDialogProps {
  isOpen: boolean;
  onClose: () => void;
  subPage?: boolean;
  /** Which tab to display first when the dialog mounts; defaults to "proxies". */
  initialTab?: "proxies" | "vpns";
}

export function ProxyManagementDialog({
  isOpen,
  onClose,
  subPage,
  initialTab = "proxies",
}: ProxyManagementDialogProps) {
  const { t } = useTranslation();
  const { profiles: referencedProfiles, failed: referencesFailed } =
    useProfileReferences(isOpen);
  // Proxy state
  const [showProxyForm, setShowProxyForm] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [editingProxy, setEditingProxy] = useState<StoredProxy | null>(null);
  const [proxyToDelete, setProxyToDelete] = useState<StoredProxy | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [proxySyncStatus, setProxySyncStatus] = useState<
    Record<string, SyncStatus>
  >({});
  const [proxySyncErrors, setProxySyncErrors] = useState<
    Record<string, string>
  >({});
  const [proxyInUse, setProxyInUse] = useState<Record<string, boolean>>({});
  const [isTogglingSync, setIsTogglingSync] = useState<Record<string, boolean>>(
    {},
  );

  // VPN state
  const [showVpnForm, setShowVpnForm] = useState(false);
  const [showVpnImportDialog, setShowVpnImportDialog] = useState(false);
  const [editingVpn, setEditingVpn] = useState<VpnConfig | null>(null);
  const [vpnToDelete, setVpnToDelete] = useState<VpnConfig | null>(null);
  const [isDeletingVpn, setIsDeletingVpn] = useState(false);
  const [vpnSyncStatus, setVpnSyncStatus] = useState<
    Record<string, SyncStatus>
  >({});
  const [vpnSyncErrors, setVpnSyncErrors] = useState<Record<string, string>>(
    {},
  );
  const [vpnInUse, setVpnInUse] = useState<Record<string, boolean>>({});
  const [isTogglingVpnSync, setIsTogglingVpnSync] = useState<
    Record<string, boolean>
  >({});

  // Table state
  const [proxiesRowSelection, setProxiesRowSelection] =
    useState<RowSelectionState>({});
  const [vpnsRowSelection, setVpnsRowSelection] = useState<RowSelectionState>(
    {},
  );

  // Track the active tab so we can scope the floating action bar (portaled
  // to body) to only the currently visible list. Initial value comes from
  // initialTab; subsequent changes drive the animated tabs via onValueChange.
  const [activeTab, setActiveTab] = useState<"proxies" | "vpns">(initialTab);
  // Reset selections when the dialog closes so the floating action bar
  // (portaled to body) doesn't linger on the page across navigations.
  useEffect(() => {
    if (!isOpen) {
      setProxiesRowSelection({});
      setVpnsRowSelection({});
    }
  }, [isOpen]);

  // Bulk delete state
  const [isBulkDeletingProxies, setIsBulkDeletingProxies] = useState(false);
  const [showBulkDeleteProxiesDialog, setShowBulkDeleteProxiesDialog] =
    useState(false);
  const [isBulkDeletingVpns, setIsBulkDeletingVpns] = useState(false);
  const [showBulkDeleteVpnsDialog, setShowBulkDeleteVpnsDialog] =
    useState(false);

  const { storedProxies: rawProxies, proxyUsage, isLoading } = useProxyEvents();
  const { vpnConfigs, vpnUsage, isLoading: isLoadingVpns } = useVpnEvents();

  // Filter out cloud-managed and cloud-derived proxies (cloud proxies are
  // deprecated). Memoized — without this the derived array gets a new
  // reference on every render, which made the [storedProxies] effect below
  // refire every render → re-set state → re-render, freezing the page once
  // the dialog mounted. Keeping the reference stable when the input is
  // unchanged is what every consumer (useReactTable, useEffect, selection
  // logic) actually wants.
  const storedProxies = useMemo(
    () =>
      rawProxies
        .filter((p) => !p.is_cloud_managed && !p.is_cloud_derived)
        .sort((a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
        ),
    [rawProxies],
  );

  // Listen for proxy sync status events
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      unlisten = await listen<{ id: string; status: string; error?: string }>(
        "proxy-sync-status",
        (event) => {
          const { id, status, error } = event.payload;
          setProxySyncStatus((prev) => ({
            ...prev,
            [id]: status as SyncStatus,
          }));
          if (error) {
            setProxySyncErrors((prev) => ({ ...prev, [id]: error }));
          }
        },
      );
    };

    void setupListener();
    return () => {
      unlisten?.();
    };
  }, []);

  // Listen for VPN sync status events
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      unlisten = await listen<{ id: string; status: string; error?: string }>(
        "vpn-sync-status",
        (event) => {
          const { id, status, error } = event.payload;
          setVpnSyncStatus((prev) => ({
            ...prev,
            [id]: status as SyncStatus,
          }));
          if (error) {
            setVpnSyncErrors((prev) => ({ ...prev, [id]: error }));
          }
        },
      );
    };

    void setupListener();
    return () => {
      unlisten?.();
    };
  }, []);

  // Load whether sync is required by an assigned profile.
  useEffect(() => {
    const loadProxyInUse = async () => {
      const inUse = await Promise.all(
        storedProxies.map((proxy) =>
          invoke<boolean>("is_proxy_in_use_by_synced_profile", {
            proxyId: proxy.id,
          }).catch(() => false),
        ),
      );
      setProxyInUse(
        Object.fromEntries(
          storedProxies.map((proxy, i) => [proxy.id, inUse[i]]),
        ),
      );
    };
    if (storedProxies.length > 0) {
      void loadProxyInUse();
    }
  }, [storedProxies]);

  // Load VPN in-use status
  useEffect(() => {
    const loadVpnInUse = async () => {
      const inUse = await Promise.all(
        vpnConfigs.map((vpn) =>
          invoke<boolean>("is_vpn_in_use_by_synced_profile", {
            vpnId: vpn.id,
          }).catch(() => false),
        ),
      );
      setVpnInUse(
        Object.fromEntries(vpnConfigs.map((vpn, i) => [vpn.id, inUse[i]])),
      );
    };
    if (vpnConfigs.length > 0) {
      void loadVpnInUse();
    }
  }, [vpnConfigs]);

  const { request: requestProxyTrash, remove: removeProxies } =
    useEntityTrash("proxy");
  const { request: requestVpnTrash, remove: removeVpns } =
    useEntityTrash("vpn");

  /** Rows that left the list leave the selection too. */
  const dropProxySelection = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setProxiesRowSelection((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  }, []);
  const dropVpnSelection = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setVpnsRowSelection((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  }, []);

  // Proxy handlers: a delete goes to the trash at once and the toast offers
  // Undo. Only "Delete at once" asks first, through the dialog below.
  const handleDeleteProxy = useCallback(
    async (proxy: StoredProxy) => {
      dropProxySelection(
        await requestProxyTrash([proxy], () => setProxyToDelete(proxy)),
      );
    },
    [requestProxyTrash, dropProxySelection],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!proxyToDelete) return;
    setIsDeleting(true);
    try {
      dropProxySelection(await removeProxies([proxyToDelete]));
    } finally {
      setIsDeleting(false);
      setProxyToDelete(null);
    }
  }, [proxyToDelete, removeProxies, dropProxySelection]);

  const handleCreateProxy = useCallback(() => {
    setEditingProxy(null);
    setShowProxyForm(true);
  }, []);

  const handleEditProxy = useCallback((proxy: StoredProxy) => {
    setEditingProxy(proxy);
    setShowProxyForm(true);
  }, []);

  const handleProxyFormClose = useCallback(() => {
    setShowProxyForm(false);
    setEditingProxy(null);
  }, []);

  const handleToggleSync = useCallback(
    async (proxy: StoredProxy) => {
      setIsTogglingSync((prev) => ({ ...prev, [proxy.id]: true }));
      try {
        await invoke("set_proxy_sync_enabled", {
          proxyId: proxy.id,
          enabled: !proxy.sync_enabled,
        });
        showSuccessToast(
          proxy.sync_enabled
            ? t("proxies.management.syncDisabled")
            : t("proxies.management.syncEnabled"),
        );
        await emit("stored-proxies-changed");
      } catch (error) {
        console.error("Failed to toggle sync:", error);
        showErrorToast(
          parseBackendError(error)
            ? translateBackendError(t, error)
            : t("proxies.management.updateSyncFailed"),
        );
      } finally {
        setIsTogglingSync((prev) => ({ ...prev, [proxy.id]: false }));
      }
    },
    [t],
  );

  // VPN handlers
  const handleDeleteVpn = useCallback(
    async (vpn: VpnConfig) => {
      dropVpnSelection(await requestVpnTrash([vpn], () => setVpnToDelete(vpn)));
    },
    [requestVpnTrash, dropVpnSelection],
  );

  const handleConfirmDeleteVpn = useCallback(async () => {
    if (!vpnToDelete) return;
    setIsDeletingVpn(true);
    try {
      dropVpnSelection(await removeVpns([vpnToDelete]));
    } finally {
      setIsDeletingVpn(false);
      setVpnToDelete(null);
    }
  }, [vpnToDelete, removeVpns, dropVpnSelection]);

  const handleCreateVpn = useCallback(() => {
    setEditingVpn(null);
    setShowVpnForm(true);
  }, []);

  const handleEditVpn = useCallback((vpn: VpnConfig) => {
    setEditingVpn(vpn);
    setShowVpnForm(true);
  }, []);

  const handleVpnFormClose = useCallback(() => {
    setShowVpnForm(false);
    setEditingVpn(null);
  }, []);

  const handleToggleVpnSync = useCallback(
    async (vpn: VpnConfig) => {
      setIsTogglingVpnSync((prev) => ({ ...prev, [vpn.id]: true }));
      try {
        await invoke("set_vpn_sync_enabled", {
          vpnId: vpn.id,
          enabled: !vpn.sync_enabled,
        });
        showSuccessToast(
          vpn.sync_enabled
            ? t("proxies.management.syncDisabled")
            : t("proxies.management.syncEnabled"),
        );
        await emit("vpn-configs-changed");
      } catch (error) {
        console.error("Failed to toggle VPN sync:", error);
        showErrorToast(
          parseBackendError(error)
            ? translateBackendError(t, error)
            : t("proxies.management.updateSyncFailed"),
        );
      } finally {
        setIsTogglingVpnSync((prev) => ({ ...prev, [vpn.id]: false }));
      }
    },
    [t],
  );

  const hasRotation = storedProxies.some((proxy) => proxy.rotation_url);
  const proxyColumns = useMemo<ColumnDef<StoredProxy>[]>(
    () => [
      { id: "select", size: 36, enableSorting: false },
      {
        accessorKey: "name",
        enableSorting: true,
        sortingFn: "alphanumeric",
        header: ({ column }) => (
          <SortableColumnHeader
            column={column}
            label={t("common.labels.name")}
          />
        ),
        cell: ({ row }) => (
          <button
            type="button"
            className="block max-w-full min-w-0 truncate rounded-sm text-left font-medium hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => {
              handleEditProxy(row.original);
            }}
          >
            {row.original.name}
          </button>
        ),
      },
      {
        id: "protocol",
        size: 100,
        enableSorting: false,
        header: () => t("proxies.management.protocolCol"),
        cell: ({ row }) => {
          const settings = row.original.proxy_settings;
          const proxyType = settings.proxy_type;
          // Shadowsocks keeps its cipher in `username`, and the cipher is what
          // decides this hop.
          const cipher = settings.username;
          const encrypted = isFirstHopEncrypted(
            proxyType,
            cipher,
            settings.vless_uri,
          );
          // A stored Shadowsocks proxy can carry no cipher at all, and with
          // none recorded the honest answer is "undecided", not "plaintext",
          // which is what the add/edit form says too.
          const cipherUndecided =
            !encrypted &&
            canonicalProxyType(proxyType) === "ss" &&
            (cipher ?? "").trim().length === 0;
          // The type is free text from the REST API, so an unrecognised one
          // still prints itself; only a blank one falls back to the label.
          const protocolLabel =
            proxyProtocolToken(canonicalProxyType(proxyType)) ||
            t("proxies.management.protocolUnknown");
          const typeName = proxyTypeLabelKey(proxyType);
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <KindBadge
                  data-first-hop={
                    encrypted
                      ? "encrypted"
                      : cipherUndecided
                        ? "cipher"
                        : "plaintext"
                  }
                  icon={encrypted ? <LuLock aria-hidden="true" /> : null}
                >
                  {protocolLabel}
                </KindBadge>
              </TooltipTrigger>
              <TooltipContent>
                {typeName && <p className="font-medium">{t(typeName)}</p>}
                <p>
                  {encrypted
                    ? t("proxies.management.firstHopEncryptedTooltip")
                    : cipherUndecided
                      ? t("proxies.management.firstHopCipherTooltip")
                      : t("proxies.management.firstHopPlaintextTooltip")}
                </p>
              </TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        id: "hostPort",
        size: 132,
        enableSorting: false,
        header: () => t("proxies.management.hostPort"),
        cell: ({ row }) => (
          <span className="block truncate font-mono text-xs text-muted-foreground">
            {row.original.proxy_settings.host}:
            {row.original.proxy_settings.port}
          </span>
        ),
      },
      {
        id: "check",
        size: 120,
        enableSorting: false,
        header: () => t("common.labels.status"),
        cell: ({ row }) => (
          <ProxyCheckButton proxy={row.original} variant="status" />
        ),
      },
      {
        // WebRTC is UDP, so whether this proxy carries it decides whether a
        // profile on it can route WebRTC at all.
        id: "udp",
        size: 64,
        enableSorting: false,
        header: () => t("proxies.management.udpCol"),
        cell: ({ row }) => <ProxyUdpBadge proxy={row.original} />,
      },
      {
        id: "usage",
        size: 64,
        enableSorting: false,
        header: () => t("proxies.management.usage"),
        cell: ({ row }) => (
          <ProfileUsageButton
            label={t("appFeedback.assignedProfiles", {
              name: row.original.name,
            })}
            failed={referencesFailed}
            profiles={
              referencedProfiles?.filter(
                (profile) => profile.proxy_id === row.original.id,
              ) ?? null
            }
          />
        ),
      },
      {
        id: "sync",
        size: 80,
        enableSorting: false,
        header: () => t("proxies.management.syncCol"),
        cell: ({ row }) => {
          const proxy = row.original;
          return (
            <SyncCell
              name={proxy.name}
              enabled={Boolean(proxy.sync_enabled)}
              lastSync={proxy.last_sync}
              status={proxySyncStatus[proxy.id]}
              error={proxySyncErrors[proxy.id]}
              busy={isTogglingSync[proxy.id]}
              lockedReason={
                proxyInUse[proxy.id] ? t("syncTooltips.lockedInUse") : undefined
              }
              onToggle={() => void handleToggleSync(proxy)}
            />
          );
        },
      },
      {
        id: "actions",
        // Room for Change IP only when some proxy has a rotation link.
        size: hasRotation ? 104 : 76,
        enableSorting: false,
        header: () => (
          <span className="sr-only">{t("common.labels.actions")}</span>
        ),
        cell: ({ row }) => {
          const proxy = row.original;
          const usage = proxyUsage[proxy.id] ?? 0;
          return (
            <RowActions>
              {proxy.rotation_url && (
                <RowAction
                  data-slot="proxy-rotate"
                  label={t("proxies.rotation.action")}
                  tooltip={t("proxies.rotation.actionTooltip")}
                  icon={<LuRefreshCcwDot />}
                  onClick={() => {
                    void rotateProxyIps([proxy], t);
                  }}
                />
              )}
              <RowAction
                label={t("proxies.management.editProxy")}
                icon={<LuPencil />}
                onClick={() => {
                  handleEditProxy(proxy);
                }}
              />
              <RowAction
                label={t("proxies.management.deleteProxy")}
                tooltip={
                  usage > 0
                    ? t("proxies.management.cannotDelete", { count: usage })
                    : undefined
                }
                icon={<LuTrash2 />}
                tone="destructive"
                disabled={usage > 0}
                onClick={() => {
                  void handleDeleteProxy(proxy);
                }}
              />
            </RowActions>
          );
        },
      },
    ],
    [
      t,
      hasRotation,
      referencedProfiles,
      referencesFailed,
      proxySyncStatus,
      proxySyncErrors,
      proxyUsage,
      isTogglingSync,
      proxyInUse,
      handleToggleSync,
      handleEditProxy,
      handleDeleteProxy,
    ],
  );

  const proxiesTableTools = useEntityTableTools(
    "proxies",
    storedProxies,
    setProxiesRowSelection,
  );
  const proxiesTable = useReactTable({
    data: proxiesTableTools.filters.rows,
    columns: useMemo(
      () => configureEntityColumns(proxyColumns),
      [proxyColumns],
    ),
    state: {
      sorting: proxiesTableTools.view.preferences.sorting,
      columnVisibility: proxiesTableTools.visibility,
      columnSizing: proxiesTableTools.view.preferences.sizing,
      rowSelection: proxiesRowSelection,
    },
    onSortingChange: proxiesTableTools.view.setSorting,
    onColumnSizingChange: proxiesTableTools.view.setSizing,
    columnResizeMode: "onChange",
    onRowSelectionChange: setProxiesRowSelection,
    enableRowSelection: (row) => !proxyInUse[row.original.id],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.id,
  });

  const vpnColumns = useMemo<ColumnDef<VpnConfig>[]>(
    () => [
      { id: "select", size: 36, enableSorting: false },
      {
        accessorKey: "name",
        enableSorting: true,
        sortingFn: "alphanumeric",
        header: ({ column }) => (
          <SortableColumnHeader
            column={column}
            label={t("common.labels.name")}
          />
        ),
        cell: ({ row }) => (
          <button
            type="button"
            className="block max-w-full min-w-0 truncate rounded-sm text-left font-medium hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => {
              handleEditVpn(row.original);
            }}
          >
            {row.original.name}
          </button>
        ),
      },
      {
        id: "type",
        size: 104,
        enableSorting: false,
        header: () => t("common.labels.type"),
        cell: ({ row }) => (
          <KindBadge icon={<LuLock aria-hidden="true" />}>
            {row.original.vpn_type}
          </KindBadge>
        ),
      },
      {
        id: "check",
        size: 72,
        enableSorting: false,
        header: () => t("common.labels.status"),
        cell: ({ row }) => <VpnCheckButton vpn={row.original} />,
      },
      {
        id: "usage",
        size: 64,
        enableSorting: false,
        header: () => t("proxies.management.usage"),
        cell: ({ row }) => (
          <ProfileUsageButton
            label={t("appFeedback.assignedProfiles", {
              name: row.original.name,
            })}
            failed={referencesFailed}
            profiles={
              referencedProfiles?.filter(
                (profile) => profile.vpn_id === row.original.id,
              ) ?? null
            }
          />
        ),
      },
      {
        id: "sync",
        size: 80,
        enableSorting: false,
        header: () => t("proxies.management.syncCol"),
        cell: ({ row }) => {
          const vpn = row.original;
          return (
            <SyncCell
              name={vpn.name}
              enabled={Boolean(vpn.sync_enabled)}
              lastSync={vpn.last_sync}
              status={vpnSyncStatus[vpn.id]}
              error={vpnSyncErrors[vpn.id]}
              busy={isTogglingVpnSync[vpn.id]}
              lockedReason={
                vpnInUse[vpn.id] ? t("syncTooltips.lockedInUse") : undefined
              }
              onToggle={() => void handleToggleVpnSync(vpn)}
            />
          );
        },
      },
      {
        id: "actions",
        size: 76,
        enableSorting: false,
        header: () => (
          <span className="sr-only">{t("common.labels.actions")}</span>
        ),
        cell: ({ row }) => {
          const vpn = row.original;
          const usage = vpnUsage[vpn.id] ?? 0;
          return (
            <RowActions>
              <RowAction
                label={t("vpns.management.editVpn")}
                icon={<LuPencil />}
                onClick={() => {
                  handleEditVpn(vpn);
                }}
              />
              <RowAction
                label={t("vpns.management.deleteVpn")}
                tooltip={
                  usage > 0
                    ? t("vpns.management.cannotDelete", { count: usage })
                    : undefined
                }
                icon={<LuTrash2 />}
                tone="destructive"
                disabled={usage > 0}
                onClick={() => {
                  void handleDeleteVpn(vpn);
                }}
              />
            </RowActions>
          );
        },
      },
    ],
    [
      t,
      referencedProfiles,
      referencesFailed,
      vpnSyncStatus,
      vpnSyncErrors,
      vpnUsage,
      isTogglingVpnSync,
      vpnInUse,
      handleToggleVpnSync,
      handleEditVpn,
      handleDeleteVpn,
    ],
  );

  const vpnsTableTools = useEntityTableTools(
    "vpns",
    vpnConfigs,
    setVpnsRowSelection,
  );
  const vpnsTable = useReactTable({
    data: vpnsTableTools.filters.rows,
    columns: useMemo(() => configureEntityColumns(vpnColumns), [vpnColumns]),
    state: {
      sorting: vpnsTableTools.view.preferences.sorting,
      columnVisibility: vpnsTableTools.visibility,
      columnSizing: vpnsTableTools.view.preferences.sizing,
      rowSelection: vpnsRowSelection,
    },
    onSortingChange: vpnsTableTools.view.setSorting,
    onColumnSizingChange: vpnsTableTools.view.setSizing,
    columnResizeMode: "onChange",
    onRowSelectionChange: setVpnsRowSelection,
    enableRowSelection: (row) => !vpnInUse[row.original.id],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.id,
  });

  // A selected row that a search or filter hides is still selected: bulk
  // actions take the selection from the full lists.
  const selectedProxies = useMemo(
    () => storedProxies.filter((proxy) => proxiesRowSelection[proxy.id]),
    [storedProxies, proxiesRowSelection],
  );
  const selectedVpns = useMemo(
    () => vpnConfigs.filter((vpn) => vpnsRowSelection[vpn.id]),
    [vpnConfigs, vpnsRowSelection],
  );

  // Row selection is gated on sync ownership, which says nothing about local
  // use, so a selection can hold entries the per-row delete refuses. Deleting
  // one anyway leaves every profile that points at it holding an id that
  // resolves to nothing, and the browser then launches with no upstream.
  const deletableProxies = selectedProxies.filter(
    (proxy) => (proxyUsage[proxy.id] ?? 0) === 0,
  );
  const skippedProxyCount = selectedProxies.length - deletableProxies.length;
  const deletableVpns = selectedVpns.filter(
    (vpn) => (vpnUsage[vpn.id] ?? 0) === 0,
  );
  const skippedVpnCount = selectedVpns.length - deletableVpns.length;

  const warnSkippedProxies = useCallback(() => {
    if (skippedProxyCount > 0) {
      toast.warning(
        t("proxies.bulkDelete.skippedProxies", { count: skippedProxyCount }),
      );
    }
  }, [skippedProxyCount, t]);
  const warnSkippedVpns = useCallback(() => {
    if (skippedVpnCount > 0) {
      toast.warning(
        t("proxies.bulkDelete.skippedVpns", { count: skippedVpnCount }),
      );
    }
  }, [skippedVpnCount, t]);

  /** The selection bar's delete: to the trash, or ask first when it is off. */
  const handleTrashSelectedProxies = useCallback(async () => {
    if (deletableProxies.length === 0) {
      warnSkippedProxies();
      return;
    }
    const removed = await requestProxyTrash(deletableProxies, () =>
      setShowBulkDeleteProxiesDialog(true),
    );
    if (removed.length > 0) warnSkippedProxies();
    dropProxySelection(removed);
  }, [
    deletableProxies,
    requestProxyTrash,
    warnSkippedProxies,
    dropProxySelection,
  ]);

  const handleBulkDeleteProxies = useCallback(async () => {
    if (deletableProxies.length === 0) return;
    setIsBulkDeletingProxies(true);
    try {
      const removed = await removeProxies(deletableProxies);
      warnSkippedProxies();
      dropProxySelection(removed);
    } finally {
      setIsBulkDeletingProxies(false);
      setShowBulkDeleteProxiesDialog(false);
    }
  }, [deletableProxies, removeProxies, warnSkippedProxies, dropProxySelection]);

  const handleTrashSelectedVpns = useCallback(async () => {
    if (deletableVpns.length === 0) {
      warnSkippedVpns();
      return;
    }
    const removed = await requestVpnTrash(deletableVpns, () =>
      setShowBulkDeleteVpnsDialog(true),
    );
    if (removed.length > 0) warnSkippedVpns();
    dropVpnSelection(removed);
  }, [deletableVpns, requestVpnTrash, warnSkippedVpns, dropVpnSelection]);

  const handleBulkDeleteVpns = useCallback(async () => {
    if (deletableVpns.length === 0) return;
    setIsBulkDeletingVpns(true);
    try {
      const removed = await removeVpns(deletableVpns);
      warnSkippedVpns();
      dropVpnSelection(removed);
    } finally {
      setIsBulkDeletingVpns(false);
      setShowBulkDeleteVpnsDialog(false);
    }
  }, [deletableVpns, removeVpns, warnSkippedVpns, dropVpnSelection]);

  // Bulk-toggle sync: if every selectable row has sync ON, turn them all
  // OFF; otherwise turn them all ON. Items locked by a synced profile
  // (proxyInUse / vpnInUse) are skipped silently when the target is OFF.
  const handleBulkToggleProxiesSync = useCallback(async () => {
    if (selectedProxies.length === 0) return;
    const allOn = selectedProxies.every((p) => p.sync_enabled);
    const targetEnabled = !allOn;
    const targets = selectedProxies.filter((p) =>
      targetEnabled ? !p.sync_enabled : p.sync_enabled && !proxyInUse[p.id],
    );
    if (targets.length === 0) return;
    const results = await Promise.allSettled(
      targets.map((proxy) =>
        invoke("set_proxy_sync_enabled", {
          proxyId: proxy.id,
          enabled: targetEnabled,
        }),
      ),
    );
    const firstRejection = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    if (firstRejection) {
      showErrorToast(
        parseBackendError(firstRejection.reason)
          ? translateBackendError(t, firstRejection.reason)
          : t("proxies.management.updateSyncFailed"),
      );
    } else {
      showSuccessToast(
        targetEnabled
          ? t("proxies.management.syncEnabled")
          : t("proxies.management.syncDisabled"),
      );
    }
    await emit("stored-proxies-changed");
  }, [selectedProxies, proxyInUse, t]);

  /** Checks the selection a few at a time, then reports the tally once. */
  const handleBulkCheckProxies = useCallback(async () => {
    const queue = [...selectedProxies];
    if (queue.length === 0) return;
    let passed = 0;
    let failed = 0;
    const worker = async () => {
      for (let proxy = queue.shift(); proxy; proxy = queue.shift()) {
        try {
          const result = await runProxyCheck(proxy, (error) =>
            translateBackendError(t, error),
          );
          if (result?.is_valid) passed += 1;
          else if (result) failed += 1;
        } catch {
          failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    const summary = t("proxies.management.checkSummary", { passed, failed });
    if (failed === 0) showSuccessToast(summary);
    else if (passed === 0) showErrorToast(summary);
    else toast.warning(summary);
  }, [selectedProxies, t]);

  const handleBulkToggleVpnsSync = useCallback(async () => {
    if (selectedVpns.length === 0) return;
    const allOn = selectedVpns.every((v) => v.sync_enabled);
    const targetEnabled = !allOn;
    const targets = selectedVpns.filter((v) =>
      targetEnabled ? !v.sync_enabled : v.sync_enabled && !vpnInUse[v.id],
    );
    if (targets.length === 0) return;
    const results = await Promise.allSettled(
      targets.map((vpn) =>
        invoke("set_vpn_sync_enabled", {
          vpnId: vpn.id,
          enabled: targetEnabled,
        }),
      ),
    );
    const firstRejection = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    if (firstRejection) {
      showErrorToast(
        parseBackendError(firstRejection.reason)
          ? translateBackendError(t, firstRejection.reason)
          : t("proxies.management.updateSyncFailed"),
      );
    } else {
      showSuccessToast(
        targetEnabled
          ? t("proxies.management.syncEnabled")
          : t("proxies.management.syncDisabled"),
      );
    }
    await emit("vpn-configs-changed");
  }, [selectedVpns, vpnInUse, t]);

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose} subPage={subPage}>
        <DialogContent className="flex max-h-[85vh] max-w-[min(80rem,calc(100%-4rem))] flex-col">
          {!subPage && (
            <DialogHeader>
              <DialogTitle>{t("proxies.management.title")}</DialogTitle>
              <DialogDescription>
                {t("proxies.management.description")}
              </DialogDescription>
            </DialogHeader>
          )}

          <div className="@container flex min-h-0 w-full flex-1 flex-col">
            <AnimatedTabs
              key={initialTab}
              defaultValue={initialTab}
              onValueChange={(v) => setActiveTab(v as "proxies" | "vpns")}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                <AnimatedTabsList>
                  <AnimatedTabsTrigger value="proxies">
                    <span>{t("proxies.management.tabProxies")}</span>
                    <TickingCount
                      value={storedProxies.length}
                      className="text-xs"
                    />
                  </AnimatedTabsTrigger>
                  <AnimatedTabsTrigger value="vpns">
                    <span>{t("proxies.management.tabVpns")}</span>
                    <TickingCount
                      value={vpnConfigs.length}
                      className="text-xs"
                    />
                  </AnimatedTabsTrigger>
                </AnimatedTabsList>
                <div className="flex items-center gap-2">
                  {activeTab === "proxies" ? (
                    <>
                      <PageAction
                        icon={<LuUpload className="size-4" />}
                        label={t("common.buttons.import")}
                        onClick={() => {
                          setShowImportDialog(true);
                        }}
                      />
                      <PageAction
                        icon={<LuDownload className="size-4" />}
                        label={t("common.buttons.export")}
                        disabled={storedProxies.length === 0}
                        onClick={() => {
                          setShowExportDialog(true);
                        }}
                      />
                      <PageAction
                        primary
                        icon={<LuPlus className="size-4" />}
                        label={t("proxies.management.newProxy")}
                        onClick={handleCreateProxy}
                      />
                    </>
                  ) : (
                    <>
                      <PageAction
                        icon={<LuUpload className="size-4" />}
                        label={t("common.buttons.import")}
                        onClick={() => {
                          setShowVpnImportDialog(true);
                        }}
                      />
                      <PageAction
                        primary
                        icon={<LuPlus className="size-4" />}
                        label={t("proxies.management.newVpn")}
                        onClick={handleCreateVpn}
                      />
                    </>
                  )}
                </div>
              </div>

              <AnimatedTabsContent
                value="proxies"
                className="mt-4 min-h-0 flex-1 flex-col data-[state=active]:flex"
              >
                <ManagedDataTable
                  table={proxiesTable}
                  tools={proxiesTableTools}
                  loading={isLoading}
                  empty={
                    <EntityEmptyState
                      entity="proxies"
                      scene={<ProxyRouteScene />}
                      title={t("entities.empty.proxies.title")}
                      description={t("entities.empty.proxies.body")}
                    >
                      <RippleButton
                        size="sm"
                        className="gap-2"
                        onClick={handleCreateProxy}
                      >
                        <LuPlus className="size-4" />
                        {t("proxies.management.newProxy")}
                      </RippleButton>
                      <RippleButton
                        size="sm"
                        variant="soft"
                        className="gap-2"
                        onClick={() => {
                          setShowImportDialog(true);
                        }}
                      >
                        <LuUpload className="size-4" />
                        {t("common.buttons.import")}
                      </RippleButton>
                    </EntityEmptyState>
                  }
                />
              </AnimatedTabsContent>

              <AnimatedTabsContent
                value="vpns"
                className="mt-4 min-h-0 flex-1 flex-col data-[state=active]:flex"
              >
                <ManagedDataTable
                  table={vpnsTable}
                  tools={vpnsTableTools}
                  loading={isLoadingVpns}
                  empty={
                    <EntityEmptyState
                      entity="vpns"
                      scene={<VpnTunnelScene />}
                      title={t("entities.empty.vpns.title")}
                      description={t("entities.empty.vpns.body")}
                    >
                      <RippleButton
                        size="sm"
                        className="gap-2"
                        onClick={handleCreateVpn}
                      >
                        <LuPlus className="size-4" />
                        {t("proxies.management.newVpn")}
                      </RippleButton>
                      <RippleButton
                        size="sm"
                        variant="soft"
                        className="gap-2"
                        onClick={() => {
                          setShowVpnImportDialog(true);
                        }}
                      >
                        <LuUpload className="size-4" />
                        {t("common.buttons.import")}
                      </RippleButton>
                    </EntityEmptyState>
                  }
                />
              </AnimatedTabsContent>
            </AnimatedTabs>
          </div>

          {!subPage && (
            <DialogFooter>
              <RippleButton variant="outline" onClick={onClose}>
                {t("common.buttons.close")}
              </RippleButton>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      <ProxyFormDialog
        isOpen={showProxyForm}
        onClose={handleProxyFormClose}
        editingProxy={editingProxy}
      />
      <DeleteConfirmationDialog
        isOpen={proxyToDelete !== null}
        onClose={() => {
          setProxyToDelete(null);
        }}
        onConfirm={handleConfirmDelete}
        title={t("proxies.management.deleteTitle")}
        description={t("proxies.management.deleteDescription", {
          name: proxyToDelete?.name ?? "",
        })}
        confirmButtonText={t("common.buttons.delete")}
        isLoading={isDeleting}
      />
      <ProxyImportDialog
        isOpen={showImportDialog}
        onClose={() => {
          setShowImportDialog(false);
        }}
      />
      <ProxyExportDialog
        isOpen={showExportDialog}
        onClose={() => {
          setShowExportDialog(false);
        }}
      />
      <VpnFormDialog
        isOpen={showVpnForm}
        onClose={handleVpnFormClose}
        editingVpn={editingVpn}
      />
      <DeleteConfirmationDialog
        isOpen={vpnToDelete !== null}
        onClose={() => {
          setVpnToDelete(null);
        }}
        onConfirm={handleConfirmDeleteVpn}
        title={t("vpns.management.deleteTitle")}
        description={t("vpns.management.deleteDescription", {
          name: vpnToDelete?.name ?? "",
        })}
        confirmButtonText={t("common.buttons.delete")}
        isLoading={isDeletingVpn}
      />
      <VpnImportDialog
        isOpen={showVpnImportDialog}
        onClose={() => {
          setShowVpnImportDialog(false);
        }}
      />
      {isOpen && activeTab === "proxies" && (
        <DataTableActionBar table={proxiesTable}>
          <DataTableActionBarSelection table={proxiesTable} />
          <DataTableActionBarAction
            tooltip={t("syncTooltips.bulkToggle")}
            onClick={() => void handleBulkToggleProxiesSync()}
          >
            <LuRefreshCw />
          </DataTableActionBarAction>
          <DataTableActionBarAction
            tooltip={t("proxies.management.checkSelected")}
            onClick={() => void handleBulkCheckProxies()}
          >
            <LuActivity />
          </DataTableActionBarAction>
          <DataTableActionBarAction
            tooltip={t("proxies.rotation.action")}
            onClick={() => void rotateProxyIps(selectedProxies, t)}
          >
            <LuRefreshCcwDot />
          </DataTableActionBarAction>
          <DataTableActionBarAction
            tooltip={t("common.buttons.delete")}
            onClick={() => {
              void handleTrashSelectedProxies();
            }}
            variant="destructive"
            className="bg-destructive/12 text-destructive-text hover:bg-destructive/20"
          >
            <LuTrash2 />
          </DataTableActionBarAction>
        </DataTableActionBar>
      )}
      {isOpen && activeTab === "vpns" && (
        <DataTableActionBar table={vpnsTable}>
          <DataTableActionBarSelection table={vpnsTable} />
          <DataTableActionBarAction
            tooltip={t("syncTooltips.bulkToggle")}
            onClick={() => void handleBulkToggleVpnsSync()}
          >
            <LuRefreshCw />
          </DataTableActionBarAction>
          <DataTableActionBarAction
            tooltip={t("common.buttons.delete")}
            onClick={() => {
              void handleTrashSelectedVpns();
            }}
            variant="destructive"
            className="bg-destructive/12 text-destructive-text hover:bg-destructive/20"
          >
            <LuTrash2 />
          </DataTableActionBarAction>
        </DataTableActionBar>
      )}
      <DeleteConfirmationDialog
        isOpen={showBulkDeleteProxiesDialog}
        onClose={() => {
          setShowBulkDeleteProxiesDialog(false);
        }}
        onConfirm={handleBulkDeleteProxies}
        title={t("proxies.bulkDelete.proxiesTitle")}
        description={t("proxies.bulkDelete.proxiesDescription", {
          count: deletableProxies.length,
          names: deletableProxies.map((p) => p.name).join(", "),
        })}
        confirmButtonText={t("proxies.bulkDelete.confirmButton", {
          count: deletableProxies.length,
        })}
        isLoading={isBulkDeletingProxies}
      />
      <DeleteConfirmationDialog
        isOpen={showBulkDeleteVpnsDialog}
        onClose={() => {
          setShowBulkDeleteVpnsDialog(false);
        }}
        onConfirm={handleBulkDeleteVpns}
        title={t("proxies.bulkDelete.vpnsTitle")}
        description={t("proxies.bulkDelete.vpnsDescription", {
          count: deletableVpns.length,
          names: deletableVpns.map((v) => v.name).join(", "),
        })}
        confirmButtonText={t("proxies.bulkDelete.confirmButton", {
          count: deletableVpns.length,
        })}
        isLoading={isBulkDeletingVpns}
      />
    </>
  );
}
