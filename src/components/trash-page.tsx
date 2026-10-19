"use client";

import type { RowSelectionState } from "@tanstack/react-table";
import {
  type LegacyColumnDef as ColumnDef,
  getCoreRowModel,
  getSortedRowModel,
  type LegacyTable as Table,
  useLegacyTable as useReactTable,
} from "@tanstack/react-table/legacy";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { IconType } from "react-icons";
import {
  LuBlocks,
  LuFolder,
  LuLayoutTemplate,
  LuLock,
  LuPuzzle,
  LuRotateCcw,
  LuShieldCheck,
  LuTrash2,
  LuUser,
  LuWifi,
} from "react-icons/lu";
import {
  DataTableActionBar,
  DataTableActionBarAction,
  DataTableActionBarSelection,
} from "@/components/data-table-action-bar";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EntityEmptyState } from "@/components/entity-empty-state";
import {
  KindBadge,
  PageAction,
  RowAction,
  RowActions,
  TickingCount,
} from "@/components/entity-page";
import {
  ManagedDataTable,
  type useEntityTableTools,
} from "@/components/managed-data-table";
import {
  SortableColumnHeader,
  TableRowCheckbox,
  TableSelectHeader,
} from "@/components/table-controls";
import { TrashScene } from "@/components/tips/scenes-essentials";
import {
  AnimatedTabs,
  AnimatedTabsList,
  AnimatedTabsTrigger,
} from "@/components/ui/animated-tabs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { useTablePreferences } from "@/hooks/use-table-preferences";
import { useTableFilters } from "@/hooks/use-table-tools";
import { useTrashEvents } from "@/hooks/use-trash-events";
import { translateBackendError } from "@/lib/backend-errors";
import { getBrowserDisplayName } from "@/lib/browser-utils";
import { formatBytes } from "@/lib/format-bytes";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { proxyProtocolToken } from "@/lib/proxy-string";
import { canonicalProxyType } from "@/lib/proxy-type";
import {
  resolveTableVisibility,
  type TableFilter,
  type TableId,
} from "@/lib/table-tools";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type {
  BrowserProfile,
  RestoredEntity,
  StoredProxy,
  TrashEntityKind,
} from "@/types";

interface TrashPageProps {
  isOpen: boolean;
  onClose: () => void;
  subPage?: boolean;
}

type TrashKind = "profile" | TrashEntityKind;
type KindFilter = "all" | TrashKind;

/** One row of the trash, whatever was deleted. */
interface TrashRow {
  /** Unique across kinds: `<kind>:<id>`. */
  id: string;
  entityId: string;
  kind: TrashKind;
  name: string;
  detail: string;
  deleted_at: number;
  expires_at: number;
  size_bytes: number;
  sync_enabled: boolean;
  password_protected: boolean;
}

const KINDS: TrashKind[] = [
  "profile",
  "proxy",
  "vpn",
  "group",
  "extension",
  "extension_group",
  "template",
];

const KIND_ICONS: Record<TrashKind, IconType> = {
  profile: LuUser,
  proxy: LuWifi,
  vpn: LuShieldCheck,
  group: LuFolder,
  extension: LuPuzzle,
  extension_group: LuBlocks,
  template: LuLayoutTemplate,
};

/** The kind as one item ("Proxy"), for the badge. */
const KIND_LABELS: Record<TrashKind, string> = {
  profile: "trash.kind.profile",
  proxy: "trash.kind.proxy",
  vpn: "trash.kind.vpn",
  group: "trash.kind.group",
  extension: "trash.kind.extension",
  extension_group: "trash.kind.extension_group",
  template: "trash.kind.template",
};

/** The kind as a list ("Proxies"), for the tabs. */
const KIND_TABS: Record<KindFilter, string> = {
  all: "trash.kinds.all",
  profile: "trash.kinds.profile",
  proxy: "trash.kinds.proxy",
  vpn: "trash.kinds.vpn",
  group: "trash.kinds.group",
  extension: "trash.kinds.extension",
  extension_group: "trash.kinds.extension_group",
  template: "trash.kinds.template",
};

const TRASH_TABLE: TableId = "trash";
const NO_FILTERS: TableFilter<TrashRow>[] = [];
const SECONDS_PER_DAY = 24 * 60 * 60;

/** Whole days left before the entry is purged, never below zero. */
function daysUntil(expiresAt: number, nowSeconds: number): number {
  return Math.max(0, Math.ceil((expiresAt - nowSeconds) / SECONDS_PER_DAY));
}

function rowSearch(row: TrashRow) {
  return `${row.name} ${row.detail}`;
}

function entityDetail(kind: TrashEntityKind, detail: string | null): string {
  if (!detail) return "";
  if (kind === "proxy") return proxyProtocolToken(canonicalProxyType(detail));
  if (kind === "extension") return `v${detail}`;
  return detail;
}

/**
 * The retention period as a ring that drains from the top: what is left of
 * it reads at a glance beside the day count, and an entry about to go is the
 * one whose ring is nearly gone. It starts full, so the first frame is whole.
 */
function RetentionRing({
  deletedAt,
  expiresAt,
  nowSeconds,
  warning,
}: {
  deletedAt: number;
  expiresAt: number;
  nowSeconds: number;
  warning: boolean;
}) {
  const animate = useMotionAllowed();
  const total = Math.max(1, expiresAt - deletedAt);
  const left = Math.max(0, Math.min(1, (expiresAt - nowSeconds) / total));
  return (
    <svg
      data-slot="trash-retention-ring"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 -rotate-90"
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx={8} cy={8} r={6} className="stroke-border" />
      <motion.circle
        cx={8}
        cy={8}
        r={6}
        className={warning ? "stroke-warning-text" : "stroke-foreground"}
        initial={animate ? { pathLength: 1 } : false}
        animate={{ pathLength: left }}
        transition={{
          duration: animate ? MOTION_DURATION.draw : 0,
          ease: MOTION_EASE_OUT,
        }}
      />
    </svg>
  );
}

/**
 * What ManagedDataTable needs to drive the trash rows: `rows` are the ones
 * the kind tab shows, `allRows` the whole trash.
 */
function useTrashTableTools(
  rows: TrashRow[],
  allRows: TrashRow[],
  setSelection: Dispatch<SetStateAction<RowSelectionState>>,
) {
  const { t } = useTranslation();
  const view = useTablePreferences(TRASH_TABLE);
  const [width, setWidth] = useState(1024);
  const labels = useMemo(
    () =>
      (
        [
          ["name", "trash.columns.name"],
          ["kind", "trash.columns.kind"],
          ["detail", "trash.columns.detail"],
          ["deleted", "trash.columns.deleted"],
          ["expires", "trash.columns.expires"],
          ["size", "trash.columns.size"],
        ] as const
      ).map(([id, key]) => ({ id, label: t(key), hideable: id !== "name" })),
    [t],
  );
  const filters = useTableFilters(rows, rowSearch, NO_FILTERS, TRASH_TABLE);
  // Rows that left the trash leave the selection too. A row that a kind tab
  // or the search hides stays selected, as in the other tables.
  useLayoutEffect(() => {
    const existing = new Set(allRows.map((row) => row.id));
    setSelection((prev) => {
      const ids = Object.keys(prev).filter((id) => prev[id]);
      return ids.every((id) => existing.has(id))
        ? prev
        : Object.fromEntries(
            ids.filter((id) => existing.has(id)).map((id) => [id, true]),
          );
    });
  }, [allRows, setSelection]);
  const visibility = resolveTableVisibility(
    { detail: width >= 768, deleted: width >= 640, size: width >= 560 },
    view.preferences.visibility,
    ["name", "select", "actions"],
  );
  return { view, labels, filters, visibility, setWidth };
}

export function TrashPage({ isOpen, onClose, subPage }: TrashPageProps) {
  const { t, i18n } = useTranslation();
  const { profiles, entities, isLoading, error, reload } = useTrashEvents();
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [rowsToPurge, setRowsToPurge] = useState<TrashRow[]>([]);
  const [isPurging, setIsPurging] = useState(false);
  const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false);
  const [isEmptying, setIsEmptying] = useState(false);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  useEffect(() => {
    if (!isOpen) setRowSelection({});
  }, [isOpen]);

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [i18n.language],
  );
  const nowSeconds = Math.floor(Date.now() / 1000);

  const allRows = useMemo<TrashRow[]>(
    () =>
      [
        ...profiles.map<TrashRow>((profile) => ({
          id: `profile:${profile.id}`,
          entityId: profile.id,
          kind: "profile",
          name: profile.name,
          detail:
            `${getBrowserDisplayName(profile.browser)} ${profile.version}`.trim(),
          deleted_at: profile.deleted_at,
          expires_at: profile.expires_at,
          size_bytes: profile.size_bytes,
          sync_enabled: profile.sync_enabled,
          password_protected: profile.password_protected,
        })),
        ...entities.map<TrashRow>((entity) => ({
          id: `${entity.kind}:${entity.id}`,
          entityId: entity.id,
          kind: entity.kind,
          name: entity.name,
          detail: entityDetail(entity.kind, entity.detail),
          deleted_at: entity.deleted_at,
          expires_at: entity.expires_at,
          size_bytes: entity.size_bytes,
          sync_enabled: entity.sync_enabled,
          password_protected: false,
        })),
      ].sort((a, b) => b.deleted_at - a.deleted_at),
    [profiles, entities],
  );

  const counts = useMemo(() => {
    const result = new Map<TrashKind, number>();
    for (const row of allRows)
      result.set(row.kind, (result.get(row.kind) ?? 0) + 1);
    return result;
  }, [allRows]);
  // A kind whose last entry left falls back to everything.
  const activeKind: KindFilter =
    kindFilter !== "all" && counts.has(kindFilter) ? kindFilter : "all";
  const rows = useMemo(
    () =>
      activeKind === "all"
        ? allRows
        : allRows.filter((row) => row.kind === activeKind),
    [allRows, activeKind],
  );

  const setBusy = useCallback((ids: string[], busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (busy) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const restoreRows = useCallback(
    async (targets: TrashRow[]) => {
      if (targets.length === 0) return;
      const ids = targets.map((row) => row.id);
      setBusy(ids, true);
      try {
        const results = await Promise.allSettled(
          targets.map(async (row) => {
            if (row.kind === "profile") {
              const restored = await invoke<BrowserProfile>(
                "restore_trashed_profile",
                { profileId: row.entityId },
              );
              // The restore keeps sync off when the cloud still holds the
              // profile's tombstone; say so rather than let it look synced.
              return {
                name: restored.name,
                syncOff: row.sync_enabled && restored.sync_mode === "Disabled",
                profile: true,
              };
            }
            const restored = await invoke<RestoredEntity>(
              "restore_trashed_entity",
              { kind: row.kind, id: row.entityId },
            );
            return {
              name: restored.name,
              syncOff: restored.sync_stayed_off,
              profile: false,
            };
          }),
        );
        const done = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failure) {
          showErrorToast(
            t("trash.restoreFailed", {
              error: translateBackendError(t, failure.reason),
            }),
          );
        }
        if (done.length > 0) {
          const syncOff = done.filter((item) => item.syncOff);
          showSuccessToast(
            done.length === 1
              ? t("trash.restored", { name: done[0].name })
              : t("trash.restoredMany", { count: done.length }),
            {
              description:
                syncOff.length === 0
                  ? undefined
                  : syncOff.every((item) => item.profile)
                    ? t("trash.restoredSyncOff")
                    : t("trash.restoredSyncOffEntity"),
              duration: syncOff.length > 0 ? 10000 : undefined,
              sound: "restore",
            },
          );
        }
      } finally {
        setBusy(ids, false);
      }
    },
    [setBusy, t],
  );

  const handlePurge = useCallback(async () => {
    const targets = rowsToPurge;
    if (targets.length === 0) return;
    const ids = targets.map((row) => row.id);
    setIsPurging(true);
    setBusy(ids, true);
    try {
      const results = await Promise.allSettled(
        targets.map((row) =>
          row.kind === "profile"
            ? invoke("purge_trashed_profile", { profileId: row.entityId })
            : invoke("purge_trashed_entity", {
                kind: row.kind,
                id: row.entityId,
              }),
        ),
      );
      const purged = results.filter(
        (result) => result.status === "fulfilled",
      ).length;
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure) {
        showErrorToast(
          t("trash.deleteForeverFailed", {
            error: translateBackendError(t, failure.reason),
          }),
        );
      }
      if (purged > 0) {
        showSuccessToast(
          targets.length === 1
            ? t("trash.deletedForever", { name: targets[0].name })
            : t("trash.deletedForeverMany", { count: purged }),
          { sound: "trash" },
        );
      }
      setRowsToPurge([]);
    } finally {
      setIsPurging(false);
      setBusy(ids, false);
    }
  }, [rowsToPurge, setBusy, t]);

  const handleEmptyTrash = useCallback(async () => {
    setIsEmptying(true);
    try {
      const removed = await invoke<number>("empty_trash");
      showSuccessToast(t("trash.emptied", { count: removed }), {
        sound: "trash",
      });
      setEmptyConfirmOpen(false);
    } catch (err: unknown) {
      console.error("Failed to empty trash:", err);
      showErrorToast(
        t("trash.emptyFailed", { error: translateBackendError(t, err) }),
      );
    } finally {
      setIsEmptying(false);
    }
  }, [t]);

  const columns = useMemo<ColumnDef<TrashRow>[]>(
    () => [
      {
        id: "select",
        size: 36,
        enableSorting: false,
        enableHiding: false,
        enableResizing: false,
        header: ({ table }) => <TableSelectHeader table={table} />,
        cell: ({ row, table }) => <TableRowCheckbox row={row} table={table} />,
      },
      {
        accessorKey: "name",
        minSize: 48,
        maxSize: 1600,
        enableHiding: false,
        enableSorting: true,
        sortingFn: "alphanumeric",
        header: ({ column }) => (
          <SortableColumnHeader
            column={column}
            label={t("trash.columns.name")}
          />
        ),
        cell: ({ row }) => {
          const Icon = KIND_ICONS[row.original.kind];
          return (
            <div className="flex min-w-0 items-center gap-2">
              <Icon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="truncate font-medium">{row.original.name}</span>
              {row.original.password_protected && (
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <span
                      role="img"
                      className="grid shrink-0 place-items-center text-muted-foreground"
                      aria-label={t("trash.passwordProtected")}
                    >
                      <LuLock className="size-3.5" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("trash.passwordProtected")}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          );
        },
      },
      {
        id: "kind",
        size: 150,
        minSize: 48,
        maxSize: 1600,
        enableSorting: true,
        accessorFn: (row) => t(KIND_LABELS[row.kind]),
        header: ({ column }) => (
          <SortableColumnHeader
            column={column}
            label={t("trash.columns.kind")}
          />
        ),
        cell: ({ row }) => (
          <KindBadge data-kind={row.original.kind}>
            {t(KIND_LABELS[row.original.kind])}
          </KindBadge>
        ),
      },
      {
        id: "detail",
        size: 180,
        minSize: 48,
        maxSize: 1600,
        enableSorting: true,
        accessorFn: (row) => row.detail,
        header: ({ column }) => (
          <SortableColumnHeader
            column={column}
            label={t("trash.columns.detail")}
          />
        ),
        cell: ({ row }) => (
          <span className="block truncate text-muted-foreground tabular-nums">
            {row.original.detail || "—"}
          </span>
        ),
      },
      {
        id: "deleted",
        size: 172,
        minSize: 48,
        maxSize: 1600,
        enableSorting: true,
        accessorFn: (row) => row.deleted_at,
        header: ({ column }) => (
          <SortableColumnHeader
            column={column}
            label={t("trash.columns.deleted")}
          />
        ),
        cell: ({ row }) => (
          <span className="block truncate text-muted-foreground tabular-nums">
            {dateFormatter.format(row.original.deleted_at * 1000)}
          </span>
        ),
      },
      {
        id: "expires",
        size: 132,
        minSize: 48,
        maxSize: 1600,
        enableSorting: true,
        accessorFn: (row) => row.expires_at,
        header: ({ column }) => (
          <SortableColumnHeader
            column={column}
            label={t("trash.columns.expires")}
          />
        ),
        cell: ({ row }) => {
          const daysLeft = daysUntil(row.original.expires_at, nowSeconds);
          return (
            <span
              className={cn(
                "inline-flex min-w-0 items-center gap-1.5 tabular-nums",
                daysLeft <= 1 ? "text-warning-text" : "text-muted-foreground",
              )}
            >
              <RetentionRing
                deletedAt={row.original.deleted_at}
                expiresAt={row.original.expires_at}
                nowSeconds={nowSeconds}
                warning={daysLeft <= 1}
              />
              <span className="truncate">
                {daysLeft === 0
                  ? t("trash.expiresToday")
                  : t("trash.expiresIn", { count: daysLeft })}
              </span>
            </span>
          );
        },
      },
      {
        id: "size",
        size: 96,
        minSize: 48,
        maxSize: 1600,
        enableSorting: true,
        accessorFn: (row) => row.size_bytes,
        header: ({ column }) => (
          <SortableColumnHeader
            column={column}
            label={t("trash.columns.size")}
          />
        ),
        cell: ({ row }) => (
          <span className="block truncate text-muted-foreground tabular-nums">
            {formatBytes(row.original.size_bytes)}
          </span>
        ),
      },
      {
        id: "actions",
        size: 76,
        enableSorting: false,
        enableHiding: false,
        enableResizing: false,
        header: () => (
          <span className="sr-only">{t("common.labels.actions")}</span>
        ),
        cell: ({ row }) => {
          const busy = busyIds.has(row.original.id);
          return (
            <RowActions>
              <RowAction
                data-slot="trash-restore"
                label={t("trash.restore")}
                icon={<LuRotateCcw />}
                disabled={busy}
                onClick={() => {
                  void restoreRows([row.original]);
                }}
              />
              <RowAction
                data-slot="trash-delete-forever"
                label={t("trash.deleteForever")}
                icon={<LuTrash2 />}
                tone="destructive"
                disabled={busy}
                onClick={() => {
                  setRowsToPurge([row.original]);
                }}
              />
            </RowActions>
          );
        },
      },
    ],
    [t, dateFormatter, nowSeconds, busyIds, restoreRows],
  );

  const tools = useTrashTableTools(rows, allRows, setRowSelection);
  const table = useReactTable({
    data: tools.filters.rows,
    columns,
    state: {
      sorting: tools.view.preferences.sorting,
      columnVisibility: tools.visibility,
      columnSizing: tools.view.preferences.sizing,
      rowSelection,
    },
    onSortingChange: tools.view.setSorting,
    onColumnSizingChange: tools.view.setSizing,
    columnResizeMode: "onChange",
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.id,
  });
  const selectedRows = useMemo(
    () => allRows.filter((row) => rowSelection[row.id]),
    [allRows, rowSelection],
  );
  // ManagedDataTable is typed for the entity pages' rows; it reads only `id`
  // and `name` from a row, which every trash row has.
  const managedTable = table as unknown as Table<StoredProxy>;
  const managedTools = tools as unknown as ReturnType<
    typeof useEntityTableTools<StoredProxy>
  >;

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose} subPage={subPage}>
        <DialogContent className="flex max-h-[85vh] max-w-[min(80rem,calc(100%-4rem))] flex-col">
          {!subPage && (
            <DialogHeader>
              <DialogTitle>{t("trash.title")}</DialogTitle>
              <DialogDescription>{t("trash.description")}</DialogDescription>
            </DialogHeader>
          )}

          <div
            data-slot="trash-page"
            className="@container flex min-h-0 w-full flex-1 flex-col"
          >
            <AnimatedTabs
              value={activeKind}
              onValueChange={(value) => {
                setKindFilter(value as KindFilter);
              }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                <AnimatedTabsList aria-label={t("trash.columns.kind")}>
                  {(["all", ...KINDS] as KindFilter[])
                    .filter((kind) => kind === "all" || counts.has(kind))
                    .map((kind) => (
                      <AnimatedTabsTrigger
                        key={kind}
                        value={kind}
                        data-kind={kind}
                      >
                        <span>{t(KIND_TABS[kind])}</span>
                        <TickingCount
                          slot={
                            kind === "all" ? "trash-summary-count" : undefined
                          }
                          value={
                            kind === "all"
                              ? allRows.length
                              : (counts.get(kind) ?? 0)
                          }
                          className="text-xs"
                        />
                      </AnimatedTabsTrigger>
                    ))}
                </AnimatedTabsList>
                <PageAction
                  data-slot="trash-empty"
                  icon={<LuTrash2 className="size-4" />}
                  label={t("trash.emptyTrash")}
                  disabled={allRows.length === 0 || isLoading}
                  onClick={() => {
                    setEmptyConfirmOpen(true);
                  }}
                />
              </div>

              {subPage && (
                <p className="mt-2 shrink-0 text-xs text-muted-foreground">
                  {t("trash.description")}
                </p>
              )}

              {error && (
                <div
                  role="alert"
                  className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive-text"
                >
                  <span className="min-w-0 break-words">{error}</span>
                  <Button
                    variant="subtle"
                    size="sm"
                    className="h-7 shrink-0"
                    onClick={() => void reload()}
                  >
                    {t("common.buttons.retry")}
                  </Button>
                </div>
              )}

              <div className="mt-4 flex min-h-0 flex-1 flex-col">
                <ManagedDataTable
                  table={managedTable}
                  tools={managedTools}
                  loading={isLoading}
                  empty={
                    error ? undefined : (
                      <EntityEmptyState
                        entity="trash"
                        scene={<TrashScene />}
                        title={t("trash.empty")}
                        description={t("trash.emptyHint")}
                      />
                    )
                  }
                />
              </div>
            </AnimatedTabs>
          </div>
        </DialogContent>
      </Dialog>

      {isOpen && (
        <DataTableActionBar table={table}>
          <DataTableActionBarSelection table={table} />
          <DataTableActionBarAction
            tooltip={t("trash.restore")}
            onClick={() => {
              void restoreRows(selectedRows);
            }}
          >
            <LuRotateCcw />
          </DataTableActionBarAction>
          <DataTableActionBarAction
            tooltip={t("trash.deleteForever")}
            onClick={() => {
              setRowsToPurge(selectedRows);
            }}
            variant="destructive"
            className="bg-destructive/12 text-destructive-text hover:bg-destructive/20"
          >
            <LuTrash2 />
          </DataTableActionBarAction>
        </DataTableActionBar>
      )}

      <DeleteConfirmationDialog
        isOpen={rowsToPurge.length > 0}
        onClose={() => {
          if (!isPurging) setRowsToPurge([]);
        }}
        onConfirm={handlePurge}
        title={t("trash.confirmDeleteForeverTitle")}
        description={
          rowsToPurge.length === 1
            ? t("trash.confirmDeleteForeverDescription", {
                name: rowsToPurge[0].name,
              })
            : t("trash.confirmEmptyDescription", { count: rowsToPurge.length })
        }
        confirmButtonText={t("trash.deleteForever")}
        isLoading={isPurging}
      />

      <DeleteConfirmationDialog
        isOpen={emptyConfirmOpen}
        onClose={() => {
          setEmptyConfirmOpen(false);
        }}
        onConfirm={handleEmptyTrash}
        title={t("trash.confirmEmptyTitle")}
        description={t("trash.confirmEmptyDescription", {
          count: allRows.length,
        })}
        confirmButtonText={t("trash.emptyTrash")}
        isLoading={isEmptying}
      />
    </>
  );
}
