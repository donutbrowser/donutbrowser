"use client";

import { type RowSelectionState } from "@tanstack/react-table";
import {
  type LegacyColumnDef as ColumnDef,
  getCoreRowModel,
  getSortedRowModel,
  useLegacyTable as useReactTable,
} from "@tanstack/react-table/legacy";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuBookmark,
  LuFolder,
  LuPencil,
  LuPlus,
  LuRefreshCw,
  LuTrash2,
} from "react-icons/lu";
import { CreateGroupDialog } from "@/components/create-group-dialog";
import {
  DataTableActionBar,
  DataTableActionBarAction,
  DataTableActionBarSelection,
} from "@/components/data-table-action-bar";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EditGroupDialog } from "@/components/edit-group-dialog";
import { EntityEmptyState } from "@/components/entity-empty-state";
import {
  PageAction,
  RowAction,
  RowActions,
  SyncCell,
  type SyncStatus,
  TickingCount,
} from "@/components/entity-page";
import { GroupBookmarksDialog } from "@/components/group-bookmarks-dialog";
import {
  configureEntityColumns,
  ManagedDataTable,
  useEntityTableTools,
} from "@/components/managed-data-table";
import { ProfileUsageButton } from "@/components/profile-usage-button";
import { SortableColumnHeader } from "@/components/table-controls";
import { GroupsScene } from "@/components/tips/scenes-essentials";
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
import { useEntityTrash } from "@/hooks/use-trash-events";
import { parseBackendError, translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { GroupWithCount, ProfileGroup } from "@/types";
import { RippleButton } from "./ui/ripple";

interface GroupManagementDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onGroupManagementComplete: () => void;
  subPage?: boolean;
}

export function GroupManagementDialog({
  isOpen,
  onClose,
  onGroupManagementComplete,
  subPage,
}: GroupManagementDialogProps) {
  const { t } = useTranslation();
  const { profiles: referencedProfiles, failed: referencesFailed } =
    useProfileReferences(isOpen);
  const [groups, setGroups] = useState<GroupWithCount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [groupToDelete, setGroupToDelete] = useState<GroupWithCount | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [bookmarksDialogOpen, setBookmarksDialogOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<GroupWithCount | null>(
    null,
  );
  const [groupSyncStatus, setGroupSyncStatus] = useState<
    Record<string, SyncStatus>
  >({});
  const [groupSyncErrors, setGroupSyncErrors] = useState<
    Record<string, string>
  >({});
  const [groupInUse, setGroupInUse] = useState<Record<string, boolean>>({});
  const [isTogglingSync, setIsTogglingSync] = useState<Record<string, boolean>>(
    {},
  );

  // Table state
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  // Listen for group sync status events
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      unlisten = await listen<{ id: string; status: string; error?: string }>(
        "group-sync-status",
        (event) => {
          const { id, status, error } = event.payload;
          setGroupSyncStatus((prev) => ({
            ...prev,
            [id]: status as SyncStatus,
          }));
          if (error) {
            setGroupSyncErrors((prev) => ({ ...prev, [id]: error }));
          }
        },
      );
    };

    void setupListener();
    return () => {
      unlisten?.();
    };
  }, []);

  const loadGroups = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const groupList = await invoke<GroupWithCount[]>(
        "get_groups_with_profile_counts",
      );
      setGroups(groupList);

      const inUse = await Promise.all(
        groupList.map((group) =>
          invoke<boolean>("is_group_in_use_by_synced_profile", {
            groupId: group.id,
          }).catch(() => false),
        ),
      );
      setGroupInUse(
        Object.fromEntries(groupList.map((group, i) => [group.id, inUse[i]])),
      );
    } catch (err) {
      console.error("Failed to load groups:", err);
      setError(
        err instanceof Error ? err.message : t("groupManagement.loadFailed"),
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  const handleGroupCreated = useCallback(
    (_newGroup: ProfileGroup) => {
      void loadGroups();
      onGroupManagementComplete();
    },
    [loadGroups, onGroupManagementComplete],
  );

  const handleGroupUpdated = useCallback(
    (_updatedGroup: ProfileGroup) => {
      void loadGroups();
      onGroupManagementComplete();
    },
    [loadGroups, onGroupManagementComplete],
  );

  // A delete, the trash sweep and an Undo from a toast all change the list.
  useEffect(() => {
    if (!isOpen) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen("groups-changed", () => {
      void loadGroups();
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isOpen, loadGroups]);

  const { request: requestGroupTrash, remove: removeGroups } =
    useEntityTrash("group");

  /** Groups that left the list leave the selection and the page too. */
  const afterGroupsRemoved = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      setRowSelection((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
      onGroupManagementComplete();
    },
    [onGroupManagementComplete],
  );

  const handleEditGroup = useCallback((group: GroupWithCount) => {
    setSelectedGroup(group);
    setEditDialogOpen(true);
  }, []);

  // A group goes to the trash at once and the toast offers Undo. Its
  // profiles keep it, so a restore puts them back in it. Only "Delete at
  // once" asks first.
  const handleDeleteGroup = useCallback(
    async (group: GroupWithCount) => {
      afterGroupsRemoved(
        await requestGroupTrash([group], () => setGroupToDelete(group)),
      );
    },
    [requestGroupTrash, afterGroupsRemoved],
  );

  const handleConfirmDeleteGroup = useCallback(async () => {
    if (!groupToDelete) return;
    setIsDeleting(true);
    try {
      afterGroupsRemoved(await removeGroups([groupToDelete]));
    } finally {
      setIsDeleting(false);
      setGroupToDelete(null);
    }
  }, [groupToDelete, removeGroups, afterGroupsRemoved]);

  const handleEditBookmarks = useCallback((group: GroupWithCount) => {
    setSelectedGroup(group);
    setBookmarksDialogOpen(true);
  }, []);

  const handleToggleSync = useCallback(
    async (group: GroupWithCount) => {
      setIsTogglingSync((prev) => ({ ...prev, [group.id]: true }));
      try {
        await invoke("set_group_sync_enabled", {
          groupId: group.id,
          enabled: !group.sync_enabled,
        });
        showSuccessToast(
          group.sync_enabled
            ? t("proxies.management.syncDisabled")
            : t("proxies.management.syncEnabled"),
        );
        await loadGroups();
      } catch (error) {
        console.error("Failed to toggle sync:", error);
        showErrorToast(
          parseBackendError(error)
            ? translateBackendError(t, error)
            : t("proxies.management.updateSyncFailed"),
        );
      } finally {
        setIsTogglingSync((prev) => ({ ...prev, [group.id]: false }));
      }
    },
    [loadGroups, t],
  );

  useEffect(() => {
    if (isOpen) {
      void loadGroups();
    } else {
      // Drop any selection when the dialog closes so the floating
      // action bar (portaled to body) doesn't linger on the page.
      setRowSelection({});
    }
  }, [isOpen, loadGroups]);

  const columns = useMemo<ColumnDef<GroupWithCount>[]>(
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
            className="flex max-w-full min-w-0 items-center gap-2 rounded-sm text-left font-medium hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => {
              handleEditGroup(row.original);
            }}
          >
            <LuFolder
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="truncate">{row.original.name}</span>
          </button>
        ),
      },
      {
        id: "count",
        size: 80,
        enableSorting: false,
        header: () => t("groupManagement.profilesCol"),
        cell: ({ row }) => (
          <ProfileUsageButton
            label={t("appFeedback.assignedProfiles", {
              name: row.original.name,
            })}
            failed={referencesFailed}
            profiles={
              referencedProfiles?.filter(
                (profile) => profile.group_id === row.original.id,
              ) ?? null
            }
          />
        ),
      },
      {
        id: "bookmarks",
        size: 104,
        enableSorting: false,
        header: () => t("groupManagement.bookmarksCol"),
        cell: ({ row }) => {
          const group = row.original;
          const label = t("groupBookmarks.editTooltip", {
            n: group.bookmark_count ?? 0,
          });
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="subtle"
                  size="sm"
                  data-testid="group-bookmarks-button"
                  aria-label={label}
                  className="h-7 gap-1.5 px-1.5 tabular-nums"
                  onClick={() => {
                    handleEditBookmarks(group);
                  }}
                >
                  <LuBookmark className="size-3.5" />
                  {group.bookmark_count ?? 0}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{label}</p>
              </TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        id: "sync",
        size: 80,
        enableSorting: false,
        header: () => t("proxies.management.syncCol"),
        cell: ({ row }) => {
          const group = row.original;
          return (
            <SyncCell
              name={group.name}
              enabled={Boolean(group.sync_enabled)}
              lastSync={group.last_sync}
              status={groupSyncStatus[group.id]}
              error={groupSyncErrors[group.id]}
              busy={isTogglingSync[group.id]}
              lockedReason={
                groupInUse[group.id] ? t("syncTooltips.lockedInUse") : undefined
              }
              onToggle={() => void handleToggleSync(group)}
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
          const group = row.original;
          return (
            <RowActions>
              <RowAction
                label={t("groupManagement.editGroupTooltip")}
                icon={<LuPencil />}
                onClick={() => {
                  handleEditGroup(group);
                }}
              />
              <RowAction
                label={t("groupManagement.deleteGroupTooltip")}
                icon={<LuTrash2 />}
                tone="destructive"
                onClick={() => {
                  void handleDeleteGroup(group);
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
      groupSyncStatus,
      groupSyncErrors,
      groupInUse,
      isTogglingSync,
      handleToggleSync,
      handleEditGroup,
      handleDeleteGroup,
      handleEditBookmarks,
    ],
  );

  const tableTools = useEntityTableTools("groups", groups, setRowSelection);
  const table = useReactTable({
    data: tableTools.filters.rows,
    columns: useMemo(() => configureEntityColumns(columns), [columns]),
    state: {
      sorting: tableTools.view.preferences.sorting,
      rowSelection,
      columnVisibility: tableTools.visibility,
      columnSizing: tableTools.view.preferences.sizing,
    },
    onSortingChange: tableTools.view.setSorting,
    onColumnSizingChange: tableTools.view.setSizing,
    columnResizeMode: "onChange",
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.id,
  });

  // A selected row that a search or filter hides is still selected: bulk
  // actions take the selection from the full list.
  const selectedGroupsForBulk = useMemo(
    () => groups.filter((group) => rowSelection[group.id]),
    [groups, rowSelection],
  );
  const selectedNames = useMemo(
    () => selectedGroupsForBulk.map((g) => g.name).join(", "),
    [selectedGroupsForBulk],
  );

  const handleTrashSelected = useCallback(async () => {
    afterGroupsRemoved(
      await requestGroupTrash(selectedGroupsForBulk, () =>
        setBulkDeleteOpen(true),
      ),
    );
  }, [selectedGroupsForBulk, requestGroupTrash, afterGroupsRemoved]);

  const handleBulkDelete = useCallback(async () => {
    if (selectedGroupsForBulk.length === 0) return;
    setIsBulkDeleting(true);
    try {
      afterGroupsRemoved(await removeGroups(selectedGroupsForBulk));
      setBulkDeleteOpen(false);
    } finally {
      setIsBulkDeleting(false);
    }
  }, [selectedGroupsForBulk, removeGroups, afterGroupsRemoved]);

  const handleBulkToggleSync = useCallback(async () => {
    if (selectedGroupsForBulk.length === 0) return;
    const allOn = selectedGroupsForBulk.every((g) => g.sync_enabled);
    const targetEnabled = !allOn;
    const targets = selectedGroupsForBulk.filter((g) =>
      targetEnabled ? !g.sync_enabled : g.sync_enabled && !groupInUse[g.id],
    );
    if (targets.length === 0) return;
    const results = await Promise.allSettled(
      targets.map((group) =>
        invoke("set_group_sync_enabled", {
          groupId: group.id,
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
    await loadGroups();
  }, [selectedGroupsForBulk, groupInUse, loadGroups, t]);

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose} subPage={subPage}>
        <DialogContent className="flex max-h-[85vh] max-w-[min(80rem,calc(100%-4rem))] flex-col">
          {!subPage && (
            <DialogHeader>
              <DialogTitle>{t("groups.management")}</DialogTitle>
              <DialogDescription>
                {t("groups.noGroupDescription")}
              </DialogDescription>
            </DialogHeader>
          )}

          <div className="@container flex min-h-0 w-full flex-1 flex-col">
            <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-2">
              <AnimatedTabs value="groups">
                <AnimatedTabsList>
                  <AnimatedTabsTrigger value="groups" data-summary="groups">
                    <span data-slot="group-summary-title">
                      {t("groups.pageTitle")}
                    </span>
                    <TickingCount
                      slot="group-summary-count"
                      value={groups.length}
                      className="text-xs"
                    />
                  </AnimatedTabsTrigger>
                </AnimatedTabsList>
              </AnimatedTabs>
              <PageAction
                primary
                icon={<LuPlus className="size-4" />}
                label={t("groupManagement.newGroup")}
                onClick={() => {
                  setCreateDialogOpen(true);
                }}
              />
            </div>

            {error && (
              <div
                role="alert"
                className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive-text"
              >
                <span className="min-w-0 break-words">{error}</span>
                <Button
                  variant="subtle"
                  size="sm"
                  className="h-7 shrink-0"
                  onClick={() => void loadGroups()}
                >
                  {t("common.buttons.retry")}
                </Button>
              </div>
            )}

            <ManagedDataTable
              table={table}
              tools={tableTools}
              loading={isLoading}
              empty={
                error ? undefined : (
                  <EntityEmptyState
                    entity="groups"
                    scene={<GroupsScene />}
                    title={t("entities.empty.groups.title")}
                    description={t("entities.empty.groups.body")}
                  >
                    <RippleButton
                      size="sm"
                      className="gap-2"
                      onClick={() => {
                        setCreateDialogOpen(true);
                      }}
                    >
                      <LuPlus className="size-4" />
                      {t("groupManagement.newGroup")}
                    </RippleButton>
                  </EntityEmptyState>
                )
              }
            />
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

      {isOpen && (
        <DataTableActionBar table={table}>
          <DataTableActionBarSelection table={table} />
          <DataTableActionBarAction
            tooltip={t("syncTooltips.bulkToggle")}
            onClick={() => {
              void handleBulkToggleSync();
            }}
          >
            <LuRefreshCw />
          </DataTableActionBarAction>
          <DataTableActionBarAction
            tooltip={t("common.buttons.delete")}
            onClick={() => {
              void handleTrashSelected();
            }}
            variant="destructive"
            className="bg-destructive/12 text-destructive-text hover:bg-destructive/20"
          >
            <LuTrash2 />
          </DataTableActionBarAction>
        </DataTableActionBar>
      )}

      <DeleteConfirmationDialog
        isOpen={bulkDeleteOpen}
        onClose={() => {
          if (!isBulkDeleting) setBulkDeleteOpen(false);
        }}
        onConfirm={handleBulkDelete}
        title={t("groupManagement.bulkDelete.title")}
        description={t("groupManagement.bulkDelete.description", {
          count: selectedGroupsForBulk.length,
          names: selectedNames,
        })}
        confirmButtonText={t("groupManagement.bulkDelete.confirmButton")}
        isLoading={isBulkDeleting}
      />

      <CreateGroupDialog
        isOpen={createDialogOpen}
        onClose={() => {
          setCreateDialogOpen(false);
        }}
        onGroupCreated={handleGroupCreated}
      />

      <EditGroupDialog
        isOpen={editDialogOpen}
        onClose={() => {
          setEditDialogOpen(false);
        }}
        group={selectedGroup}
        onGroupUpdated={handleGroupUpdated}
      />

      <GroupBookmarksDialog
        isOpen={bookmarksDialogOpen}
        onClose={() => {
          setBookmarksDialogOpen(false);
        }}
        groupId={selectedGroup?.id ?? null}
        groupName={selectedGroup?.name ?? ""}
        onBookmarksSaved={() => {
          void loadGroups();
          onGroupManagementComplete();
        }}
      />

      <DeleteConfirmationDialog
        isOpen={groupToDelete !== null}
        onClose={() => {
          if (!isDeleting) setGroupToDelete(null);
        }}
        onConfirm={handleConfirmDeleteGroup}
        title={t("groups.deleteTitle")}
        description={t("groupManagement.bulkDelete.description", {
          count: 1,
          names: groupToDelete?.name ?? "",
        })}
        confirmButtonText={t("groups.deleteGroup")}
        isLoading={isDeleting}
      />
    </>
  );
}
