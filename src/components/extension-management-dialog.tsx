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
import { open } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  LuArchive,
  LuChrome,
  LuExternalLink,
  LuFolder,
  LuFolderOpen,
  LuGlobe,
  LuInfo,
  LuLink,
  LuPencil,
  LuPlus,
  LuPuzzle,
  LuRefreshCw,
  LuSearch,
  LuTrash2,
  LuUpload,
} from "react-icons/lu";
import { AssignmentImpact } from "@/components/assignment-impact";
import {
  DataTableActionBar,
  DataTableActionBarAction,
  DataTableActionBarSelection,
} from "@/components/data-table-action-bar";
import {
  EntityEmptyState,
  ExtensionDropScene,
} from "@/components/entity-empty-state";
import {
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
import { SortableColumnHeader } from "@/components/table-controls";
import { ExtensionsScene } from "@/components/tips/scenes-essentials";
import {
  AnimatedTabs,
  AnimatedTabsContent,
  AnimatedTabsList,
  AnimatedTabsTrigger,
} from "@/components/ui/animated-tabs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProBadge } from "@/components/ui/pro-badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { useProfileReferences } from "@/hooks/use-profile-references";
import { useEntityTrash } from "@/hooks/use-trash-events";
import { parseBackendError, translateBackendError } from "@/lib/backend-errors";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { Extension, ExtensionGroup, FetchedExtension } from "@/types";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { RippleButton } from "./ui/ripple";

/** A payload staged in the UI, before it is handed to the backend. */
type PendingSource =
  | { kind: "archive"; fileName: string; data: number[] }
  | { kind: "folder"; path: string };

const ARCHIVE_EXTENSIONS = [".crx", ".zip"];

/** Above this many extensions, the group editor offers a search field. */
const MEMBER_SEARCH_THRESHOLD = 8;

function pathBaseName(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/**
 * A form that opens above the list; it slides in and out with its content.
 * It is readable from the first frame: it enters half visible, never hidden.
 */
function StagePanel({ slot, children }: { slot: string; children: ReactNode }) {
  const animate = useMotionAllowed();
  return (
    <motion.div
      data-slot={slot}
      initial={
        animate ? { opacity: 0.5, transform: "translateY(-4px)" } : false
      }
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      exit={{
        opacity: 0,
        transform: animate ? "translateY(-4px)" : "translateY(0px)",
        transition: { duration: animate ? MOTION_DURATION.fast : 0 },
      }}
      transition={{ duration: MOTION_DURATION.base, ease: MOTION_EASE_OUT }}
      className="shrink-0 space-y-3 rounded-xl bg-foreground/3 p-3"
    >
      {children}
    </motion.div>
  );
}

interface ExtensionManagementDialogProps {
  isOpen: boolean;
  onClose: () => void;
  limitedMode: boolean;
  subPage?: boolean;
  /** Which tab is displayed when the dialog mounts; defaults to "extensions". */
  initialTab?: "extensions" | "groups";
}

export function ExtensionManagementDialog({
  isOpen,
  onClose,
  limitedMode,
  subPage,
  initialTab = "extensions",
}: ExtensionManagementDialogProps) {
  const { t } = useTranslation();
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [extensionGroups, setExtensionGroups] = useState<ExtensionGroup[]>([]);
  const [isLoading, setIsLoading] = useState(!limitedMode);

  // Extension import state
  const [isUploading, setIsUploading] = useState(false);
  /** Set before the first await, so a second Enter cannot add a second copy. */
  const uploadingRef = useRef(false);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const creatingGroupRef = useRef(false);
  const [extensionName, setExtensionName] = useState("");
  const [pendingSource, setPendingSource] = useState<PendingSource | null>(
    null,
  );
  const [linkFolder, setLinkFolder] = useState(false);
  const [showUrlForm, setShowUrlForm] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  /** Identity read out of a downloaded archive's own manifest, shown before
   * the extension is saved so the user sees what a link actually resolved to. */
  const [fetchedIdentity, setFetchedIdentity] = useState<{
    name: string;
    version: string | null;
    source: string;
  } | null>(null);

  // Group state
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [editingGroup, setEditingGroup] = useState<ExtensionGroup | null>(null);
  const [editGroupName, setEditGroupName] = useState("");
  const [editGroupExtensionIds, setEditGroupExtensionIds] = useState<string[]>(
    [],
  );
  const [memberQuery, setMemberQuery] = useState("");

  // Delete state
  const [extensionToDelete, setExtensionToDelete] = useState<Extension | null>(
    null,
  );
  const [groupToDelete, setGroupToDelete] = useState<ExtensionGroup | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);

  // Bulk delete state
  const [bulkExtDeleteOpen, setBulkExtDeleteOpen] = useState(false);
  const [bulkGroupDeleteOpen, setBulkGroupDeleteOpen] = useState(false);

  // Table state
  const [extRowSelection, setExtRowSelection] = useState<RowSelectionState>({});
  const [groupRowSelection, setGroupRowSelection] = useState<RowSelectionState>(
    {},
  );

  // Edit extension state
  const { profiles: referencedProfiles, failed: referencesFailed } =
    useProfileReferences(isOpen);
  const [editingExtension, setEditingExtension] = useState<Extension | null>(
    null,
  );
  const [editExtensionName, setEditExtensionName] = useState("");
  const [pendingUpdateSource, setPendingUpdateSource] =
    useState<PendingSource | null>(null);
  const [editLinkFolder, setEditLinkFolder] = useState(false);

  // Extension icons
  const [extensionIcons, setExtensionIcons] = useState<Record<string, string>>(
    {},
  );

  // Sync state
  const [extSyncStatus, setExtSyncStatus] = useState<
    Record<string, SyncStatus>
  >({});
  const [isTogglingExtSync, setIsTogglingExtSync] = useState<
    Record<string, boolean>
  >({});
  const [isTogglingGroupSync, setIsTogglingGroupSync] = useState<
    Record<string, boolean>
  >({});

  // Tab — keyed off `initialTab` so remounting the dialog with a new initial
  // tab (e.g. via the Mod+E shortcut toggle) jumps to that tab.
  const [activeTab, setActiveTab] = useState<"extensions" | "groups">(
    initialTab,
  );

  const loadData = useCallback(async () => {
    if (limitedMode) return;
    setIsLoading(true);
    try {
      const [exts, groups] = await Promise.all([
        invoke<Extension[]>("list_extensions"),
        invoke<ExtensionGroup[]>("list_extension_groups"),
      ]);
      setExtensions(exts);
      setExtensionGroups(groups);
    } catch {
      // User may not have pro subscription
      setExtensions([]);
      setExtensionGroups([]);
    } finally {
      setIsLoading(false);
    }
  }, [limitedMode]);

  const loadIcons = useCallback(async (exts: Extension[]) => {
    const icons: Record<string, string> = {};
    for (const ext of exts) {
      try {
        const icon = await invoke<string | null>("get_extension_icon", {
          extensionId: ext.id,
        });
        if (icon) {
          icons[ext.id] = icon;
        }
      } catch {
        // Icon not available
      }
    }
    setExtensionIcons(icons);
  }, []);

  useEffect(() => {
    if (isOpen) {
      void loadData();
    } else {
      // Drop selection when the dialog closes so the floating action
      // bars (portaled to body) don't linger on the page.
      setExtRowSelection({});
      setGroupRowSelection({});
    }
  }, [isOpen, loadData]);

  useEffect(() => {
    if (extensions.length > 0) {
      void loadIcons(extensions);
    }
  }, [extensions, loadIcons]);

  // A delete, the trash sweep and an Undo from a toast all change the lists.
  useEffect(() => {
    if (!isOpen) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen("extensions-changed", () => {
      void loadData();
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isOpen, loadData]);

  // Listen for extension sync status events
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      unlisten = await listen<{ id: string; status: string }>(
        "extension-sync-status",
        (event) => {
          const { id, status } = event.payload;
          setExtSyncStatus((prev) => ({
            ...prev,
            [id]: status as SyncStatus,
          }));
        },
      );
    };

    void setupListener();
    return () => {
      unlisten?.();
    };
  }, []);

  /** Structured backend codes win; anything else falls back to a local message
   * so the user never sees a raw Rust string. */
  const showActionError = useCallback(
    (err: unknown, fallback: string) => {
      showErrorToast(
        parseBackendError(err) ? translateBackendError(t, err) : fallback,
      );
    },
    [t],
  );

  const resetImportForm = useCallback(() => {
    setPendingSource(null);
    setExtensionName("");
    setLinkFolder(false);
    setFetchedIdentity(null);
  }, []);

  const closeEditExtension = useCallback(() => {
    setEditingExtension(null);
    setEditExtensionName("");
    setPendingUpdateSource(null);
    setEditLinkFolder(false);
  }, []);

  const handleToggleExtSync = useCallback(
    async (ext: Extension) => {
      setIsTogglingExtSync((prev) => ({ ...prev, [ext.id]: true }));
      try {
        await invoke("set_extension_sync_enabled", {
          extensionId: ext.id,
          enabled: !ext.sync_enabled,
        });
        showSuccessToast(
          ext.sync_enabled
            ? t("extensions.syncDisabled")
            : t("extensions.syncEnabled"),
        );
        void loadData();
      } catch (err) {
        showActionError(err, t("proxies.management.updateSyncFailed"));
      } finally {
        setIsTogglingExtSync((prev) => ({ ...prev, [ext.id]: false }));
      }
    },
    [loadData, showActionError, t],
  );

  const handleToggleGroupSync = useCallback(
    async (group: ExtensionGroup) => {
      setIsTogglingGroupSync((prev) => ({ ...prev, [group.id]: true }));
      try {
        await invoke("set_extension_group_sync_enabled", {
          extensionGroupId: group.id,
          enabled: !group.sync_enabled,
        });
        showSuccessToast(
          group.sync_enabled
            ? t("extensions.syncDisabled")
            : t("extensions.syncEnabled"),
        );
        void loadData();
      } catch (err) {
        showActionError(err, t("proxies.management.updateSyncFailed"));
      } finally {
        setIsTogglingGroupSync((prev) => ({ ...prev, [group.id]: false }));
      }
    },
    [loadData, showActionError, t],
  );

  const handleUpdateExtension = useCallback(async () => {
    if (!editingExtension || !editExtensionName.trim()) return;
    try {
      if (pendingUpdateSource?.kind === "folder") {
        await invoke("update_extension_from_path", {
          extensionId: editingExtension.id,
          name: editExtensionName.trim(),
          path: pendingUpdateSource.path,
          link: editLinkFolder,
        });
      } else {
        await invoke("update_extension", {
          extensionId: editingExtension.id,
          name: editExtensionName.trim(),
          fileName: pendingUpdateSource?.fileName ?? null,
          fileData: pendingUpdateSource?.data ?? null,
        });
      }
      showSuccessToast(t("extensions.updateSuccess"));
      closeEditExtension();
      void loadData();
    } catch (err) {
      showActionError(err, t("extensions.updateFailed"));
    }
  }, [
    editingExtension,
    editExtensionName,
    pendingUpdateSource,
    editLinkFolder,
    closeEditExtension,
    loadData,
    showActionError,
    t,
  ]);

  /** Reads a picked archive into memory, shared by the import and the replace
   * flows. Resolves to null when the file is rejected or unreadable. */
  const readArchiveFile = useCallback(
    (file: File): Promise<PendingSource | null> => {
      const isValid = ARCHIVE_EXTENSIONS.some((ext) =>
        file.name.toLowerCase().endsWith(ext),
      );
      if (!isValid) {
        showErrorToast(t("extensions.invalidFileType"));
        return Promise.resolve(null);
      }

      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          const arrayBuffer = event.target?.result as ArrayBuffer;
          resolve({
            kind: "archive",
            fileName: file.name,
            data: Array.from(new Uint8Array(arrayBuffer)),
          });
        };
        reader.onerror = () => {
          showErrorToast(t("extensions.readError"));
          resolve(null);
        };
        reader.readAsArrayBuffer(file);
      });
    },
    [t],
  );

  const handleEditFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;

      void readArchiveFile(file).then((source) => {
        if (!source) return;
        setPendingUpdateSource(source);
        setEditLinkFolder(false);
      });
    },
    [readArchiveFile],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;

      void readArchiveFile(file).then((source) => {
        if (!source) return;
        setExtensionName(
          file.name.replace(/\.(crx|zip)$/i, "").replace(/[-_]/g, " "),
        );
        setLinkFolder(false);
        setFetchedIdentity(null);
        setPendingSource(source);
      });
    },
    [readArchiveFile],
  );

  /** Native directory picker, the "Load unpacked" entry point. */
  const pickExtensionFolder = useCallback(async (): Promise<string | null> => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("extensions.selectFolderTitle"),
      });
      return typeof selected === "string" ? selected : null;
    } catch (err) {
      console.error("Failed to open folder dialog:", err);
      showErrorToast(t("importProfile.folderDialogFailed"));
      return null;
    }
  }, [t]);

  const handleLoadUnpacked = useCallback(async () => {
    const folder = await pickExtensionFolder();
    if (!folder) return;
    setExtensionName(pathBaseName(folder).replace(/[-_]/g, " "));
    setLinkFolder(false);
    setFetchedIdentity(null);
    setPendingSource({ kind: "folder", path: folder });
  }, [pickExtensionFolder]);

  const pickArchive = useCallback(() => {
    document.getElementById("ext-file-input")?.click();
  }, []);

  const handleEditFolderSelect = useCallback(async () => {
    const folder = await pickExtensionFolder();
    if (!folder) return;
    setPendingUpdateSource({ kind: "folder", path: folder });
  }, [pickExtensionFolder]);

  /** Stage a link exactly as a picked file is staged: the download is
   * validated and its manifest read in the backend, and the user still
   * confirms the name before anything is stored. */
  const handleFetchFromUrl = useCallback(async () => {
    const link = urlInput.trim();
    if (!link || isFetchingUrl) return;
    setIsFetchingUrl(true);
    try {
      const fetched = await invoke<FetchedExtension>(
        "fetch_extension_from_url",
        { url: link },
      );
      const identity = fetched.name?.trim() ?? "";
      setPendingSource({
        kind: "archive",
        fileName: fetched.file_name,
        data: fetched.file_data,
      });
      setExtensionName(identity || fetched.file_name.replace(/\.zip$/i, ""));
      setLinkFolder(false);
      setFetchedIdentity({
        name: identity || fetched.file_name,
        version: fetched.version?.trim() || null,
        source: fetched.source_url,
      });
      setShowUrlForm(false);
      setUrlInput("");
      showSuccessToast(t("extensions.fetchSuccess"));
    } catch (err) {
      showActionError(err, t("extensions.fetchFailed"));
    } finally {
      setIsFetchingUrl(false);
    }
  }, [urlInput, isFetchingUrl, showActionError, t]);

  const handleUpload = useCallback(async () => {
    if (!pendingSource || !extensionName.trim() || uploadingRef.current) return;
    uploadingRef.current = true;
    setIsUploading(true);
    try {
      if (pendingSource.kind === "folder") {
        await invoke("add_unpacked_extension", {
          name: extensionName.trim(),
          path: pendingSource.path,
          link: linkFolder,
        });
      } else {
        await invoke("add_extension", {
          name: extensionName.trim(),
          fileName: pendingSource.fileName,
          fileData: pendingSource.data,
        });
      }
      showSuccessToast(t("extensions.uploadSuccess"));
      resetImportForm();
      void loadData();
    } catch (err) {
      showActionError(err, t("extensions.uploadFailed"));
    } finally {
      uploadingRef.current = false;
      setIsUploading(false);
    }
  }, [
    pendingSource,
    extensionName,
    linkFolder,
    resetImportForm,
    loadData,
    showActionError,
    t,
  ]);

  const { request: requestExtensionTrash, remove: removeExtensions } =
    useEntityTrash("extension");
  const { request: requestGroupTrash, remove: removeGroups } =
    useEntityTrash("extension_group");

  /** Rows that left a list leave its selection too. */
  const dropExtSelection = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setExtRowSelection((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  }, []);
  const dropGroupSelection = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setGroupRowSelection((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  }, []);

  // A delete goes to the trash at once and the toast offers Undo. Only
  // "Delete at once" asks first, through the confirmations below.
  const trashExtension = useCallback(
    async (ext: Extension) => {
      dropExtSelection(
        await requestExtensionTrash([ext], () => setExtensionToDelete(ext)),
      );
    },
    [requestExtensionTrash, dropExtSelection],
  );

  const trashGroup = useCallback(
    async (group: ExtensionGroup) => {
      dropGroupSelection(
        await requestGroupTrash([group], () => setGroupToDelete(group)),
      );
    },
    [requestGroupTrash, dropGroupSelection],
  );

  const handleDeleteExtension = useCallback(async () => {
    if (!extensionToDelete) return;
    setIsDeleting(true);
    try {
      dropExtSelection(await removeExtensions([extensionToDelete]));
      setExtensionToDelete(null);
    } finally {
      setIsDeleting(false);
    }
  }, [extensionToDelete, removeExtensions, dropExtSelection]);

  const handleCreateGroup = useCallback(async () => {
    if (!newGroupName.trim() || creatingGroupRef.current) return;
    creatingGroupRef.current = true;
    setIsCreatingGroup(true);
    try {
      await invoke("create_extension_group", { name: newGroupName.trim() });
      showSuccessToast(t("extensions.groupCreateSuccess"));
      setShowCreateGroup(false);
      setNewGroupName("");
      void loadData();
    } catch (err) {
      showActionError(err, t("extensions.groupCreateFailed"));
    } finally {
      creatingGroupRef.current = false;
      setIsCreatingGroup(false);
    }
  }, [newGroupName, loadData, showActionError, t]);

  const handleSaveGroupEdits = useCallback(async () => {
    if (!editingGroup || !editGroupName.trim()) return;
    try {
      // Update group name
      await invoke("update_extension_group", {
        groupId: editingGroup.id,
        name: editGroupName.trim(),
      });

      // Compute diff of extensions
      const originalIds = new Set(editingGroup.extension_ids);
      const newIds = new Set(editGroupExtensionIds);

      // Add new extensions
      for (const extId of editGroupExtensionIds) {
        if (!originalIds.has(extId)) {
          await invoke("add_extension_to_group", {
            groupId: editingGroup.id,
            extensionId: extId,
          });
        }
      }

      // Remove removed extensions
      for (const extId of editingGroup.extension_ids) {
        if (!newIds.has(extId)) {
          await invoke("remove_extension_from_group", {
            groupId: editingGroup.id,
            extensionId: extId,
          });
        }
      }

      showSuccessToast(t("extensions.groupUpdateSuccess"));
      setEditingGroup(null);
      setEditGroupName("");
      setEditGroupExtensionIds([]);
      void loadData();
    } catch (err) {
      showActionError(err, t("extensions.groupUpdateFailed"));
    }
  }, [
    editingGroup,
    editGroupName,
    editGroupExtensionIds,
    loadData,
    showActionError,
    t,
  ]);

  const handleDeleteGroup = useCallback(async () => {
    if (!groupToDelete) return;
    setIsDeleting(true);
    try {
      dropGroupSelection(await removeGroups([groupToDelete]));
      setGroupToDelete(null);
    } finally {
      setIsDeleting(false);
    }
  }, [groupToDelete, removeGroups, dropGroupSelection]);

  const selectedExtensions = useMemo(
    () => extensions.filter((ext) => extRowSelection[ext.id]),
    [extensions, extRowSelection],
  );

  const selectedGroups = useMemo(
    () => extensionGroups.filter((group) => groupRowSelection[group.id]),
    [extensionGroups, groupRowSelection],
  );

  const handleTrashSelectedExtensions = useCallback(async () => {
    dropExtSelection(
      await requestExtensionTrash(selectedExtensions, () =>
        setBulkExtDeleteOpen(true),
      ),
    );
  }, [selectedExtensions, requestExtensionTrash, dropExtSelection]);

  const handleTrashSelectedGroups = useCallback(async () => {
    dropGroupSelection(
      await requestGroupTrash(selectedGroups, () =>
        setBulkGroupDeleteOpen(true),
      ),
    );
  }, [selectedGroups, requestGroupTrash, dropGroupSelection]);

  const handleBulkDeleteExtensions = useCallback(async () => {
    if (selectedExtensions.length === 0) return;
    setIsDeleting(true);
    try {
      dropExtSelection(await removeExtensions(selectedExtensions));
      setBulkExtDeleteOpen(false);
    } finally {
      setIsDeleting(false);
    }
  }, [selectedExtensions, removeExtensions, dropExtSelection]);

  const handleBulkDeleteGroups = useCallback(async () => {
    if (selectedGroups.length === 0) return;
    setIsDeleting(true);
    try {
      dropGroupSelection(await removeGroups(selectedGroups));
      setBulkGroupDeleteOpen(false);
    } finally {
      setIsDeleting(false);
    }
  }, [selectedGroups, removeGroups, dropGroupSelection]);

  const handleBulkToggleExtSync = useCallback(async () => {
    if (selectedExtensions.length === 0) return;
    const allOn = selectedExtensions.every((e) => e.sync_enabled);
    const targetEnabled = !allOn;
    // A linked extension has no payload to upload, so enabling sync on one is
    // refused by the backend. Skip them instead of failing the whole batch.
    const targets = targetEnabled
      ? selectedExtensions.filter((ext) => !ext.linked_path)
      : selectedExtensions;
    if (targets.length === 0) {
      showErrorToast(t("extensions.linkedNoSync"));
      return;
    }
    const results = await Promise.allSettled(
      targets.map((ext) =>
        invoke("set_extension_sync_enabled", {
          extensionId: ext.id,
          enabled: targetEnabled,
        }),
      ),
    );
    const firstRejection = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    if (firstRejection) {
      showActionError(
        firstRejection.reason,
        t("proxies.management.updateSyncFailed"),
      );
    } else {
      showSuccessToast(
        targetEnabled
          ? t("extensions.syncEnabled")
          : t("extensions.syncDisabled"),
      );
    }
    void loadData();
  }, [selectedExtensions, loadData, showActionError, t]);

  const handleBulkToggleGroupSync = useCallback(async () => {
    if (selectedGroups.length === 0) return;
    const allOn = selectedGroups.every((g) => g.sync_enabled);
    const targetEnabled = !allOn;
    const results = await Promise.allSettled(
      selectedGroups.map((group) =>
        invoke("set_extension_group_sync_enabled", {
          extensionGroupId: group.id,
          enabled: targetEnabled,
        }),
      ),
    );
    const firstRejection = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    if (firstRejection) {
      showActionError(
        firstRejection.reason,
        t("proxies.management.updateSyncFailed"),
      );
    } else {
      showSuccessToast(
        targetEnabled
          ? t("extensions.syncEnabled")
          : t("extensions.syncDisabled"),
      );
    }
    void loadData();
  }, [selectedGroups, loadData, showActionError, t]);

  const renderCompatIcons = useCallback(
    (compat: string[]) => {
      const hasChromium = compat.includes("chromium");
      if (!hasChromium) return null;
      return (
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <LuChrome
                  role="img"
                  aria-label={t("extensions.compatibility.chromium")}
                  className="size-3.5 text-muted-foreground"
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t("extensions.compatibility.chromium")}
            </TooltipContent>
          </Tooltip>
        </div>
      );
    },
    [t],
  );

  const renderExtensionIcon = useCallback(
    (ext: Extension, size: "sm" | "md" = "md") => {
      const sizeClass = size === "sm" ? "size-4" : "size-5";
      if (extensionIcons[ext.id]) {
        return (
          // biome-ignore lint/performance/noImgElement: base64 data URI icons cannot use next/image
          <img
            src={extensionIcons[ext.id]}
            alt=""
            className={`${sizeClass} shrink-0 rounded-sm`}
          />
        );
      }
      return (
        <LuPuzzle className={`${sizeClass} shrink-0 text-muted-foreground`} />
      );
    },
    [extensionIcons],
  );

  /** What the extension actually is: a stored archive, a folder packed into
   * the store, or a folder loaded in place from the user's disk. */
  const renderSource = useCallback(
    (ext: Extension) => {
      if (ext.linked_path) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <LuLink aria-hidden="true" className="size-3 shrink-0" />
                <span className="truncate">
                  {t("extensions.source.linked")}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs break-all">
                {t("extensions.source.linkedTooltip", {
                  path: ext.linked_path,
                })}
              </p>
            </TooltipContent>
          </Tooltip>
        );
      }
      const unpacked = ext.source_kind === "unpacked";
      return (
        <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {unpacked ? (
            <LuFolder aria-hidden="true" className="size-3 shrink-0" />
          ) : (
            <LuArchive aria-hidden="true" className="size-3 shrink-0" />
          )}
          <span className="truncate">
            {t(
              unpacked
                ? "extensions.source.unpacked"
                : "extensions.source.archive",
            )}
          </span>
        </span>
      );
    },
    [t],
  );

  const openExtensionEditor = useCallback((ext: Extension) => {
    setEditingExtension(ext);
    setEditExtensionName(ext.name);
    setPendingUpdateSource(null);
    setEditLinkFolder(Boolean(ext.linked_path));
  }, []);

  const openGroupEditor = useCallback((group: ExtensionGroup) => {
    setEditingGroup(group);
    setEditGroupName(group.name);
    setEditGroupExtensionIds([...group.extension_ids]);
    setMemberQuery("");
  }, []);

  const MAX_VISIBLE_ICONS = 3;

  const extensionColumns = useMemo<ColumnDef<Extension>[]>(
    () => [
      { id: "select", size: 36, enableSorting: false },
      {
        id: "icon",
        size: 36,
        enableSorting: false,
        header: () => null,
        cell: ({ row }) => (
          <span className="flex items-center justify-center">
            {renderExtensionIcon(row.original, "sm")}
          </span>
        ),
      },
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
            className="block max-w-full min-w-0 rounded-sm text-left text-sm font-medium hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => {
              openExtensionEditor(row.original);
            }}
          >
            <span className="block truncate">{row.original.name}</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {[
                row.original.manifest_name &&
                row.original.manifest_name !== row.original.name
                  ? row.original.manifest_name
                  : row.original.file_name,
                row.original.version && `v${row.original.version}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </button>
        ),
      },
      {
        id: "compat",
        size: 100,
        enableSorting: false,
        header: () => t("extensions.compatibility.label"),
        cell: ({ row }) =>
          renderCompatIcons(row.original.browser_compatibility),
      },
      {
        id: "source",
        size: 136,
        enableSorting: false,
        header: () => t("appFeedback.source"),
        cell: ({ row }) => renderSource(row.original),
      },
      {
        id: "usage",
        size: 88,
        enableSorting: false,
        header: () => t("profiles.title"),
        cell: ({ row }) => (
          <ProfileUsageButton
            label={t("appFeedback.assignedProfiles", {
              name: row.original.name,
            })}
            failed={referencesFailed}
            profiles={
              referencedProfiles?.filter((profile) =>
                extensionGroups.some(
                  (group) =>
                    group.id === profile.extension_group_id &&
                    group.extension_ids.includes(row.original.id),
                ),
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
          const ext = row.original;
          return (
            <SyncCell
              name={ext.name}
              enabled={Boolean(ext.sync_enabled)}
              lastSync={ext.last_sync}
              status={extSyncStatus[ext.id]}
              busy={isTogglingExtSync[ext.id]}
              lockedReason={
                ext.linked_path ? t("extensions.linkedNoSync") : undefined
              }
              onToggle={() => void handleToggleExtSync(ext)}
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
          const ext = row.original;
          return (
            <RowActions>
              <RowAction
                label={t("extensions.editExtension")}
                icon={<LuPencil />}
                onClick={() => {
                  openExtensionEditor(ext);
                }}
              />
              <RowAction
                label={t("extensions.delete")}
                icon={<LuTrash2 />}
                tone="destructive"
                onClick={() => {
                  void trashExtension(ext);
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
      extensionGroups,
      extSyncStatus,
      isTogglingExtSync,
      handleToggleExtSync,
      openExtensionEditor,
      trashExtension,
      renderExtensionIcon,
      renderCompatIcons,
      renderSource,
    ],
  );

  const extTableTools = useEntityTableTools(
    "extensions",
    extensions,
    setExtRowSelection,
  );
  const extTable = useReactTable({
    data: extTableTools.filters.rows,
    columns: useMemo(
      () => configureEntityColumns(extensionColumns),
      [extensionColumns],
    ),
    state: {
      sorting: extTableTools.view.preferences.sorting,
      columnVisibility: extTableTools.visibility,
      columnSizing: extTableTools.view.preferences.sizing,
      rowSelection: extRowSelection,
    },
    onSortingChange: extTableTools.view.setSorting,
    onColumnSizingChange: extTableTools.view.setSizing,
    columnResizeMode: "onChange",
    onRowSelectionChange: setExtRowSelection,
    enableRowSelection: () => !limitedMode,
    getSortedRowModel: getSortedRowModel(),
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  const groupColumns = useMemo<ColumnDef<ExtensionGroup>[]>(
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
            className="block max-w-full min-w-0 truncate rounded-sm text-left text-sm font-medium hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => {
              openGroupEditor(row.original);
            }}
          >
            {row.original.name}
          </button>
        ),
      },
      {
        id: "extensions",
        size: 136,
        enableSorting: false,
        header: () => t("extensions.extensionsTab"),
        cell: ({ row }) => {
          const group = row.original;
          const groupExts = group.extension_ids
            .map((id) => extensions.find((e) => e.id === id))
            .filter(Boolean) as Extension[];
          const visibleExts = groupExts.slice(0, MAX_VISIBLE_ICONS);
          const overflow = groupExts.slice(MAX_VISIBLE_ICONS);
          if (groupExts.length === 0)
            return (
              <span className="block min-w-0 truncate text-xs text-muted-foreground">
                {t("extensions.noExtensionsInGroup")}
              </span>
            );
          return (
            <div className="flex min-w-0 items-center gap-1">
              {visibleExts.map((ext) => (
                <Tooltip key={ext.id}>
                  <TooltipTrigger asChild>
                    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-foreground/5">
                      {renderExtensionIcon(ext, "sm")}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{ext.name}</TooltipContent>
                </Tooltip>
              ))}
              {overflow.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex h-6 shrink-0 items-center rounded-md bg-foreground/5 px-1.5 text-[11px] text-muted-foreground tabular-nums">
                      +{overflow.length}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className="space-y-0.5">
                      {overflow.map((ext) => (
                        <p key={ext.id} className="text-xs">
                          {ext.name}
                        </p>
                      ))}
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          );
        },
      },
      {
        id: "usage",
        size: 88,
        enableSorting: false,
        header: () => t("profiles.title"),
        cell: ({ row }) => (
          <ProfileUsageButton
            label={t("appFeedback.assignedProfiles", {
              name: row.original.name,
            })}
            failed={referencesFailed}
            profiles={
              referencedProfiles?.filter(
                (profile) => profile.extension_group_id === row.original.id,
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
          const group = row.original;
          return (
            <SyncCell
              name={group.name}
              enabled={Boolean(group.sync_enabled)}
              lastSync={group.last_sync}
              status={extSyncStatus[group.id]}
              busy={isTogglingGroupSync[group.id]}
              onToggle={() => void handleToggleGroupSync(group)}
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
                label={t("extensions.editGroup")}
                icon={<LuPencil />}
                onClick={() => {
                  openGroupEditor(group);
                }}
              />
              <RowAction
                label={t("extensions.deleteGroup")}
                icon={<LuTrash2 />}
                tone="destructive"
                onClick={() => {
                  void trashGroup(group);
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
      extensions,
      extSyncStatus,
      isTogglingGroupSync,
      handleToggleGroupSync,
      openGroupEditor,
      trashGroup,
      renderExtensionIcon,
    ],
  );

  const groupTableTools = useEntityTableTools(
    "extensionGroups",
    extensionGroups,
    setGroupRowSelection,
  );
  const groupTable = useReactTable({
    data: groupTableTools.filters.rows,
    columns: useMemo(
      () => configureEntityColumns(groupColumns),
      [groupColumns],
    ),
    state: {
      sorting: groupTableTools.view.preferences.sorting,
      columnVisibility: groupTableTools.visibility,
      columnSizing: groupTableTools.view.preferences.sizing,
      rowSelection: groupRowSelection,
    },
    onSortingChange: groupTableTools.view.setSorting,
    onColumnSizingChange: groupTableTools.view.setSizing,
    columnResizeMode: "onChange",
    onRowSelectionChange: setGroupRowSelection,
    enableRowSelection: () => !limitedMode,
    getSortedRowModel: getSortedRowModel(),
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose} subPage={subPage}>
        <DialogContent className="flex max-h-[85vh] max-w-[min(80rem,calc(100%-4rem))] flex-col">
          {!subPage && (
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <LuPuzzle className="size-5" />
                {t("extensions.title")}
                {limitedMode && <ProBadge />}
              </DialogTitle>
              <DialogDescription>
                {t("extensions.description")}
              </DialogDescription>
            </DialogHeader>
          )}

          <div className="@container relative flex min-h-0 w-full flex-1 flex-col">
            {limitedMode && (
              <>
                <div className="absolute inset-0 z-1 bg-background/30 backdrop-blur-[6px]" />
                <div className="absolute inset-y-0 left-0 z-2 w-6 bg-linear-to-r from-background to-transparent" />
                <div className="absolute inset-y-0 right-0 z-2 w-6 bg-linear-to-l from-background to-transparent" />
                <div className="absolute inset-x-0 top-0 z-2 h-6 bg-linear-to-b from-background to-transparent" />
                <div className="absolute inset-x-0 bottom-0 z-2 h-6 bg-linear-to-t from-background to-transparent" />
                <div className="absolute inset-0 z-3 flex items-center justify-center">
                  <div className="flex items-center gap-2 rounded-lg bg-background/80 px-3 py-1.5">
                    <ProBadge />
                    <span className="text-sm font-medium text-muted-foreground">
                      {t("extensions.proRequired")}
                    </span>
                  </div>
                </div>
              </>
            )}

            <AnimatedTabs
              key={initialTab}
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as "extensions" | "groups")}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                <AnimatedTabsList>
                  <AnimatedTabsTrigger
                    value="extensions"
                    disabled={limitedMode}
                  >
                    <span>{t("extensions.extensionsTab")}</span>
                    <TickingCount
                      value={extensions.length}
                      className="text-xs"
                    />
                  </AnimatedTabsTrigger>
                  <AnimatedTabsTrigger value="groups" disabled={limitedMode}>
                    <span>{t("extensions.groupsTab")}</span>
                    <TickingCount
                      value={extensionGroups.length}
                      className="text-xs"
                    />
                  </AnimatedTabsTrigger>
                </AnimatedTabsList>
                <div className="flex items-center gap-2">
                  {activeTab === "extensions" ? (
                    <>
                      <PageAction
                        icon={<LuGlobe className="size-4" />}
                        label={t("extensions.fromUrl")}
                        tooltip={t("extensions.fromUrlTooltip")}
                        disabled={limitedMode}
                        onClick={() => {
                          setShowUrlForm((open) => !open);
                        }}
                      />
                      <PageAction
                        icon={<LuFolderOpen className="size-4" />}
                        label={t("extensions.loadUnpacked")}
                        tooltip={t("extensions.loadUnpackedTooltip")}
                        disabled={limitedMode}
                        onClick={() => void handleLoadUnpacked()}
                      />
                      <PageAction
                        primary
                        icon={<LuUpload className="size-4" />}
                        label={t("extensions.upload")}
                        disabled={limitedMode}
                        onClick={pickArchive}
                      />
                    </>
                  ) : (
                    <PageAction
                      primary
                      icon={<LuPlus className="size-4" />}
                      label={t("extensions.newGroup")}
                      disabled={limitedMode}
                      onClick={() => setShowCreateGroup(true)}
                    />
                  )}
                </div>
              </div>

              <p className="mt-3 flex shrink-0 items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                <LuInfo
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0"
                />
                {t("extensions.managedNotice")}
              </p>

              <Input
                id="ext-file-input"
                type="file"
                accept=".crx,.zip"
                className="hidden"
                onChange={handleFileSelect}
                disabled={limitedMode}
              />

              <AnimatedTabsContent
                value="extensions"
                className="mt-4 min-h-0 flex-1 flex-col data-[state=active]:flex"
              >
                <div className="flex min-h-0 flex-1 flex-col gap-4">
                  <AnimatePresence initial={false}>
                    {showUrlForm && (
                      <StagePanel key="link" slot="extension-link-form">
                        <div className="flex flex-wrap gap-2">
                          <div className="relative min-w-48 flex-1">
                            <LuGlobe
                              aria-hidden="true"
                              className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
                            />
                            <Input
                              id="ext-url-input"
                              variant="soft"
                              autoFocus
                              value={urlInput}
                              onChange={(e) => {
                                setUrlInput(e.target.value);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter")
                                  void handleFetchFromUrl();
                                if (e.key === "Escape") {
                                  e.stopPropagation();
                                  setShowUrlForm(false);
                                  setUrlInput("");
                                }
                              }}
                              placeholder={t("extensions.urlPlaceholder")}
                              aria-describedby="ext-url-hint"
                              className="pl-8"
                              disabled={isFetchingUrl}
                            />
                          </div>
                          <RippleButton
                            size="sm"
                            onClick={() => void handleFetchFromUrl()}
                            disabled={
                              isFetchingUrl || urlInput.trim().length === 0
                            }
                          >
                            {isFetchingUrl
                              ? t("extensions.fetching")
                              : t("extensions.fetchExtension")}
                          </RippleButton>
                          <Button
                            size="sm"
                            variant="subtle"
                            onClick={() => {
                              setShowUrlForm(false);
                              setUrlInput("");
                            }}
                          >
                            {t("common.buttons.cancel")}
                          </Button>
                        </div>
                        <p
                          id="ext-url-hint"
                          className="text-xs text-muted-foreground"
                        >
                          {t("extensions.urlHint")}
                        </p>
                      </StagePanel>
                    )}

                    {pendingSource && (
                      <StagePanel key="staged" slot="extension-staged">
                        <div className="flex items-start gap-3">
                          <span
                            aria-hidden="true"
                            className="grid size-9 shrink-0 place-items-center rounded-lg bg-foreground/6 text-muted-foreground [&_svg]:size-4"
                          >
                            {pendingSource.kind === "folder" ? (
                              <LuFolder />
                            ) : (
                              <LuArchive />
                            )}
                          </span>
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <p className="text-xs text-muted-foreground">
                              {pendingSource.kind === "folder"
                                ? t("extensions.selectedFolder")
                                : t("extensions.selectedFile")}
                            </p>
                            <p className="text-sm font-medium break-all">
                              {pendingSource.kind === "folder"
                                ? pendingSource.path
                                : pendingSource.fileName}
                            </p>
                          </div>
                        </div>
                        {fetchedIdentity && (
                          <div className="space-y-0.5">
                            <div
                              data-slot="extension-fetched-identity"
                              className="text-sm font-medium break-all text-foreground"
                            >
                              {fetchedIdentity.version
                                ? t("extensions.fetchedIdentity", {
                                    name: fetchedIdentity.name,
                                    version: fetchedIdentity.version,
                                  })
                                : fetchedIdentity.name}
                            </div>
                            <p className="text-xs break-all text-muted-foreground">
                              {t("extensions.fetchedFrom", {
                                source: fetchedIdentity.source,
                              })}
                            </p>
                          </div>
                        )}
                        {pendingSource.kind === "folder" && (
                          <div className="flex items-start gap-2">
                            <Checkbox
                              id="ext-link-folder"
                              checked={linkFolder}
                              onCheckedChange={(value) => {
                                setLinkFolder(value === true);
                              }}
                              className="mt-0.5"
                            />
                            <div className="space-y-0.5">
                              <Label
                                htmlFor="ext-link-folder"
                                className="text-sm font-normal"
                              >
                                {t("extensions.linkFolder")}
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                {linkFolder
                                  ? t("extensions.linkFolderOn")
                                  : t("extensions.linkFolderOff")}
                              </p>
                            </div>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <Input
                            variant="soft"
                            value={extensionName}
                            onChange={(e) => {
                              setExtensionName(e.target.value);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void handleUpload();
                            }}
                            placeholder={t("extensions.namePlaceholder")}
                            aria-label={t("common.labels.name")}
                            className="min-w-48 flex-1"
                            disabled={isUploading}
                          />
                          <RippleButton
                            size="sm"
                            onClick={() => void handleUpload()}
                            disabled={isUploading || !extensionName.trim()}
                          >
                            {isUploading
                              ? t("common.buttons.loading")
                              : t("common.buttons.add")}
                          </RippleButton>
                          <Button
                            size="sm"
                            variant="subtle"
                            onClick={resetImportForm}
                          >
                            {t("common.buttons.cancel")}
                          </Button>
                        </div>
                      </StagePanel>
                    )}
                  </AnimatePresence>

                  <ManagedDataTable
                    table={extTable}
                    tools={extTableTools}
                    loading={isLoading}
                    empty={
                      showUrlForm || pendingSource ? (
                        <div className="flex-1" />
                      ) : (
                        <EntityEmptyState
                          entity="extensions"
                          scene={<ExtensionDropScene />}
                          title={t("entities.empty.extensions.title")}
                          description={t("entities.empty.extensions.body")}
                        >
                          <RippleButton
                            size="sm"
                            className="gap-2"
                            disabled={limitedMode}
                            onClick={pickArchive}
                          >
                            <LuUpload className="size-4" />
                            {t("extensions.upload")}
                          </RippleButton>
                          <RippleButton
                            size="sm"
                            variant="soft"
                            className="gap-2"
                            disabled={limitedMode}
                            onClick={() => {
                              setShowUrlForm(true);
                            }}
                          >
                            <LuGlobe className="size-4" />
                            {t("extensions.fromUrl")}
                          </RippleButton>
                        </EntityEmptyState>
                      )
                    }
                  />
                </div>
              </AnimatedTabsContent>

              <AnimatedTabsContent
                value="groups"
                className="mt-4 min-h-0 flex-1 flex-col data-[state=active]:flex"
              >
                <div className="flex min-h-0 flex-1 flex-col gap-4">
                  <AnimatePresence initial={false}>
                    {showCreateGroup && (
                      <StagePanel key="create" slot="extension-group-create">
                        <div className="flex flex-wrap gap-2">
                          <Input
                            variant="soft"
                            autoFocus
                            value={newGroupName}
                            onChange={(e) => {
                              setNewGroupName(e.target.value);
                            }}
                            placeholder={t("extensions.groupNamePlaceholder")}
                            aria-label={t("common.labels.name")}
                            className="min-w-48 flex-1"
                            disabled={isCreatingGroup}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void handleCreateGroup();
                              if (e.key === "Escape") {
                                e.stopPropagation();
                                setShowCreateGroup(false);
                                setNewGroupName("");
                              }
                            }}
                          />
                          <RippleButton
                            size="sm"
                            onClick={() => void handleCreateGroup()}
                            disabled={isCreatingGroup || !newGroupName.trim()}
                          >
                            {t("common.buttons.create")}
                          </RippleButton>
                          <Button
                            size="sm"
                            variant="subtle"
                            onClick={() => {
                              setShowCreateGroup(false);
                              setNewGroupName("");
                            }}
                          >
                            {t("common.buttons.cancel")}
                          </Button>
                        </div>
                      </StagePanel>
                    )}
                  </AnimatePresence>

                  <ManagedDataTable
                    table={groupTable}
                    tools={groupTableTools}
                    loading={isLoading}
                    empty={
                      showCreateGroup ? (
                        <div className="flex-1" />
                      ) : (
                        <EntityEmptyState
                          entity="extensionGroups"
                          scene={<ExtensionsScene />}
                          title={t("entities.empty.extensionGroups.title")}
                          description={t("entities.empty.extensionGroups.body")}
                        >
                          <RippleButton
                            size="sm"
                            className="gap-2"
                            disabled={limitedMode}
                            onClick={() => setShowCreateGroup(true)}
                          >
                            <LuPlus className="size-4" />
                            {t("extensions.newGroup")}
                          </RippleButton>
                        </EntityEmptyState>
                      )
                    }
                  />
                </div>
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

      {/* Group editing dialog */}
      <Dialog
        open={editingGroup !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingGroup(null);
            setEditGroupName("");
            setEditGroupExtensionIds([]);
          }
        }}
      >
        <DialogContent className="flex max-h-[90vh] max-w-lg flex-col">
          <DialogHeader>
            <DialogTitle>{t("extensions.editGroup")}</DialogTitle>
            <DialogDescription>
              {t("extensions.editGroupDescription")}
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="-mx-6 flex-1 overflow-y-auto px-6">
            <div className="space-y-4">
              {editingGroup && (
                <AssignmentImpact
                  sources={editGroupExtensionIds.map(
                    (id) => extensions.find((ext) => ext.id === id)?.name ?? id,
                  )}
                  groups={[editingGroup]}
                  profiles={referencedProfiles}
                  failed={referencesFailed}
                  pending={
                    JSON.stringify(editGroupExtensionIds) !==
                    JSON.stringify(editingGroup.extension_ids)
                  }
                />
              )}
              <div className="space-y-2">
                <Label htmlFor="ext-group-name">
                  {t("common.labels.name")}
                </Label>
                <Input
                  id="ext-group-name"
                  value={editGroupName}
                  onChange={(e) => {
                    setEditGroupName(e.target.value);
                  }}
                  placeholder={t("extensions.groupNamePlaceholder")}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>{t("extensions.groupExtensions")}</Label>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t("extensions.membersSelected", {
                      selected: editGroupExtensionIds.filter((id) =>
                        extensions.some((ext) => ext.id === id),
                      ).length,
                      total: extensions.length,
                    })}
                  </span>
                </div>
                {extensions.length > MEMBER_SEARCH_THRESHOLD && (
                  <div className="relative">
                    <LuSearch
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      variant="soft"
                      value={memberQuery}
                      onChange={(e) => {
                        setMemberQuery(e.target.value);
                      }}
                      placeholder={t("extensions.searchExtensions")}
                      aria-label={t("extensions.searchExtensions")}
                      className="pl-8"
                    />
                  </div>
                )}
                {extensions.length === 0 ? (
                  <p className="rounded-xl bg-foreground/3 px-3 py-4 text-center text-sm text-muted-foreground">
                    {t("extensions.empty")}
                  </p>
                ) : (
                  <ul
                    data-slot="extension-group-members"
                    className="max-h-[min(40vh,320px)] space-y-0.5 overflow-y-auto rounded-xl bg-foreground/3 p-1"
                  >
                    {extensions
                      .filter((ext) =>
                        ext.name
                          .toLowerCase()
                          .includes(memberQuery.trim().toLowerCase()),
                      )
                      .map((ext) => {
                        const id = `ext-group-member-${ext.id}`;
                        const member = editGroupExtensionIds.includes(ext.id);
                        return (
                          <li key={ext.id}>
                            <label
                              htmlFor={id}
                              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-100 hover:bg-foreground/5"
                            >
                              <Checkbox
                                id={id}
                                checked={member}
                                onCheckedChange={(checked) => {
                                  setEditGroupExtensionIds((prev) =>
                                    checked === true
                                      ? prev.includes(ext.id)
                                        ? prev
                                        : [...prev, ext.id]
                                      : prev.filter((item) => item !== ext.id),
                                  );
                                }}
                              />
                              {renderExtensionIcon(ext, "sm")}
                              <span className="min-w-0 flex-1 truncate text-sm">
                                {ext.name}
                              </span>
                              {renderCompatIcons(ext.browser_compatibility)}
                            </label>
                          </li>
                        );
                      })}
                  </ul>
                )}
              </div>
            </div>
          </ScrollArea>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditingGroup(null);
                setEditGroupName("");
                setEditGroupExtensionIds([]);
              }}
            >
              {t("common.buttons.cancel")}
            </Button>
            <RippleButton
              onClick={() => void handleSaveGroupEdits()}
              disabled={!editGroupName.trim()}
            >
              {t("common.buttons.save")}
            </RippleButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Extension editing dialog */}
      <Dialog
        open={editingExtension !== null}
        onOpenChange={(open) => {
          if (!open) closeEditExtension();
        }}
      >
        <DialogContent className="flex max-h-[90vh] max-w-lg flex-col">
          <DialogHeader>
            <DialogTitle>{t("extensions.editExtension")}</DialogTitle>
            <DialogDescription>
              {t("extensions.editExtensionDescription")}
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="-mx-6 flex-1 overflow-y-auto px-6">
            {editingExtension && (
              <div className="space-y-4">
                <AssignmentImpact
                  sources={[editExtensionName || editingExtension.name]}
                  groups={extensionGroups.filter((group) =>
                    group.extension_ids.includes(editingExtension.id),
                  )}
                  profiles={referencedProfiles}
                  failed={referencesFailed}
                  pending={pendingUpdateSource !== null}
                />
                <div className="space-y-2">
                  <Label htmlFor="ext-edit-name">
                    {t("common.labels.name")}
                  </Label>
                  <Input
                    id="ext-edit-name"
                    value={editExtensionName}
                    onChange={(e) => {
                      setEditExtensionName(e.target.value);
                    }}
                    placeholder={t("extensions.namePlaceholder")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleUpdateExtension();
                    }}
                  />
                </div>

                {editingExtension.manifest_name &&
                  editingExtension.manifest_name !== editExtensionName && (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="break-words text-muted-foreground">
                        {editingExtension.manifest_name}
                      </span>
                      <Button
                        size="sm"
                        variant="subtle"
                        className="h-7"
                        onClick={() =>
                          setEditExtensionName(
                            editingExtension.manifest_name ??
                              editingExtension.name,
                          )
                        }
                      >
                        {t("appFeedback.useManifestName")}
                      </Button>
                    </div>
                  )}
                {/* Metadata from manifest.json */}
                <div className="space-y-2 rounded-xl bg-foreground/3 p-3">
                  <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    {t("extensions.metadata")}
                  </p>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                    {editingExtension.version && (
                      <>
                        <span className="text-muted-foreground">
                          {t("extensions.version")}
                        </span>
                        <span>{editingExtension.version}</span>
                      </>
                    )}
                    {editingExtension.author && (
                      <>
                        <span className="text-muted-foreground">
                          {t("extensions.author")}
                        </span>
                        <span>{editingExtension.author}</span>
                      </>
                    )}
                    {editingExtension.description && (
                      <>
                        <span className="text-muted-foreground">
                          {t("common.labels.description")}
                        </span>
                        <span className="line-clamp-3">
                          {editingExtension.description}
                        </span>
                      </>
                    )}
                    <span className="text-muted-foreground">
                      {t("extensions.compatibility.label")}
                    </span>
                    <div className="flex items-center gap-1">
                      {renderCompatIcons(
                        editingExtension.browser_compatibility,
                      )}
                    </div>
                    <span className="text-muted-foreground">
                      {t("extensions.source.label")}
                    </span>
                    <span>
                      {editingExtension.linked_path
                        ? t("extensions.source.linked")
                        : editingExtension.source_kind === "unpacked"
                          ? t("extensions.source.unpacked")
                          : t("extensions.source.archive")}
                    </span>
                    {editingExtension.linked_path ? (
                      <>
                        <span className="text-muted-foreground">
                          {t("extensions.source.folderLabel")}
                        </span>
                        <span className="break-all">
                          {editingExtension.linked_path}
                        </span>
                        <p className="col-span-2 text-xs text-muted-foreground">
                          {t("extensions.linkFolderOn")}
                        </p>
                      </>
                    ) : (
                      <>
                        <span className="text-muted-foreground">
                          {t("common.labels.type")}
                        </span>
                        <span>.{editingExtension.file_type}</span>
                      </>
                    )}
                    {editingExtension.homepage_url && (
                      <>
                        <span className="text-muted-foreground">
                          {t("extensions.homepage")}
                        </span>
                        <a
                          href={editingExtension.homepage_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex min-w-0 items-center gap-1 text-primary-text hover:underline"
                        >
                          <span className="truncate">
                            {editingExtension.homepage_url}
                          </span>
                          <LuExternalLink className="size-3 shrink-0" />
                        </a>
                      </>
                    )}
                    {!editingExtension.version &&
                      !editingExtension.author &&
                      !editingExtension.description &&
                      !editingExtension.homepage_url && (
                        <span className="col-span-2 text-xs text-muted-foreground">
                          {t("extensions.noMetadata")}
                        </span>
                      )}
                  </div>
                </div>

                {/* Replace the payload with another archive or folder */}
                <div className="space-y-2">
                  <Label>{t("extensions.replaceSource")}</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <RippleButton
                      size="sm"
                      variant="soft"
                      onClick={() =>
                        document.getElementById("ext-edit-file-input")?.click()
                      }
                    >
                      <LuUpload className="size-3.5" />
                      {t("extensions.selectFile")}
                    </RippleButton>
                    <input
                      id="ext-edit-file-input"
                      type="file"
                      accept=".crx,.zip"
                      className="hidden"
                      onChange={handleEditFileSelect}
                    />
                    <RippleButton
                      size="sm"
                      variant="soft"
                      onClick={() => void handleEditFolderSelect()}
                    >
                      <LuFolderOpen className="size-3.5" />
                      {t("extensions.selectFolder")}
                    </RippleButton>
                    {pendingUpdateSource && (
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {pendingUpdateSource.kind === "folder"
                          ? pendingUpdateSource.path
                          : pendingUpdateSource.fileName}
                      </span>
                    )}
                  </div>
                  {pendingUpdateSource?.kind === "folder" && (
                    <div className="flex items-start gap-2 pt-1">
                      <Checkbox
                        id="ext-edit-link-folder"
                        checked={editLinkFolder}
                        onCheckedChange={(value) => {
                          setEditLinkFolder(value === true);
                        }}
                        className="mt-0.5"
                      />
                      <div className="space-y-0.5">
                        <Label
                          htmlFor="ext-edit-link-folder"
                          className="text-sm font-normal"
                        >
                          {t("extensions.linkFolder")}
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {editLinkFolder
                            ? t("extensions.linkFolderOn")
                            : t("extensions.linkFolderOff")}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </ScrollArea>

          <DialogFooter>
            <Button variant="outline" onClick={closeEditExtension}>
              {t("common.buttons.cancel")}
            </Button>
            <RippleButton
              onClick={() => void handleUpdateExtension()}
              disabled={!editExtensionName.trim()}
            >
              {t("common.buttons.save")}
            </RippleButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete extension confirmation */}
      <DeleteConfirmationDialog
        isOpen={extensionToDelete !== null}
        onClose={() => {
          setExtensionToDelete(null);
        }}
        onConfirm={handleDeleteExtension}
        title={t("extensions.deleteConfirmTitle")}
        description={t("extensions.deleteConfirmDescription", {
          name: extensionToDelete?.name ?? "",
        })}
        isLoading={isDeleting}
      />

      {/* Delete group confirmation */}
      <DeleteConfirmationDialog
        isOpen={groupToDelete !== null}
        onClose={() => {
          setGroupToDelete(null);
        }}
        onConfirm={handleDeleteGroup}
        title={t("extensions.deleteGroupConfirmTitle")}
        description={t("extensions.deleteGroupConfirmDescription", {
          name: groupToDelete?.name ?? "",
        })}
        isLoading={isDeleting}
      />

      {/* Bulk delete extensions confirmation */}
      <DeleteConfirmationDialog
        isOpen={bulkExtDeleteOpen}
        onClose={() => {
          setBulkExtDeleteOpen(false);
        }}
        onConfirm={handleBulkDeleteExtensions}
        title={t("extensions.bulkDelete.extensionsTitle")}
        description={t("extensions.bulkDelete.extensionsDescription", {
          count: selectedExtensions.length,
          names: selectedExtensions.map((ext) => ext.name).join(", "),
        })}
        confirmButtonText={t("extensions.bulkDelete.confirmButton")}
        isLoading={isDeleting}
      />

      {/* Bulk delete groups confirmation */}
      <DeleteConfirmationDialog
        isOpen={bulkGroupDeleteOpen}
        onClose={() => {
          setBulkGroupDeleteOpen(false);
        }}
        onConfirm={handleBulkDeleteGroups}
        title={t("extensions.bulkDelete.groupsTitle")}
        description={t("extensions.bulkDelete.groupsDescription", {
          count: selectedGroups.length,
          names: selectedGroups.map((group) => group.name).join(", "),
        })}
        confirmButtonText={t("extensions.bulkDelete.confirmButton")}
        isLoading={isDeleting}
      />

      {/* Bulk action bars — only mount the active tab's bar; an always-
          mounted DataTableActionBar (even with visible=false) keeps an
          AnimatePresence wrapper alive that intermittently captured pointer
          input on the proxy/extension subpages. */}
      {isOpen && activeTab === "extensions" && (
        <DataTableActionBar table={extTable}>
          <DataTableActionBarSelection table={extTable} />
          <DataTableActionBarAction
            tooltip={t("syncTooltips.bulkToggle")}
            onClick={() => {
              void handleBulkToggleExtSync();
            }}
          >
            <LuRefreshCw />
          </DataTableActionBarAction>
          <DataTableActionBarAction
            tooltip={t("common.buttons.delete")}
            variant="destructive"
            className="bg-destructive/12 text-destructive-text hover:bg-destructive/20"
            onClick={() => {
              void handleTrashSelectedExtensions();
            }}
          >
            <LuTrash2 />
          </DataTableActionBarAction>
        </DataTableActionBar>
      )}

      {isOpen && activeTab === "groups" && (
        <DataTableActionBar table={groupTable}>
          <DataTableActionBarSelection table={groupTable} />
          <DataTableActionBarAction
            tooltip={t("syncTooltips.bulkToggle")}
            onClick={() => {
              void handleBulkToggleGroupSync();
            }}
          >
            <LuRefreshCw />
          </DataTableActionBarAction>
          <DataTableActionBarAction
            tooltip={t("common.buttons.delete")}
            variant="destructive"
            className="bg-destructive/12 text-destructive-text hover:bg-destructive/20"
            onClick={() => {
              void handleTrashSelectedGroups();
            }}
          >
            <LuTrash2 />
          </DataTableActionBarAction>
        </DataTableActionBar>
      )}
    </>
  );
}
