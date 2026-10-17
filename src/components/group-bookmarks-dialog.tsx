"use client";

import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { GoPlus } from "react-icons/go";
import {
  LuBookmark,
  LuChevronDown,
  LuChevronUp,
  LuTrash2,
} from "react-icons/lu";
import { useEntityMotion } from "@/components/entity-page";
import { LoadingButton } from "@/components/loading-button";
import { Button } from "@/components/ui/button";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { translateBackendError } from "@/lib/backend-errors";
import { MOTION_EASE_OUT, MOTION_SPRING_POSITION } from "@/lib/motion";
import { showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { BrowserProfile, GroupBookmark } from "@/types";
import { RippleButton } from "./ui/ripple";

interface GroupBookmarksDialogProps {
  isOpen: boolean;
  onClose: () => void;
  groupId: string | null;
  groupName: string;
  onBookmarksSaved: () => void;
}

/** A row carries its own key so React keeps focus while a row is reordered. */
interface BookmarkRow extends GroupBookmark {
  key: string;
}

function newKey(): string {
  return `bookmark-${Math.random().toString(36).slice(2)}`;
}

function toRows(bookmarks: GroupBookmark[]): BookmarkRow[] {
  return bookmarks.map((bookmark) => ({
    key: newKey(),
    title: bookmark.title,
    url: bookmark.url,
    folder: bookmark.folder ?? "",
  }));
}

function RowButton({
  testId,
  label,
  destructive = false,
  disabled,
  onClick,
  children,
}: {
  testId: string;
  label: string;
  destructive?: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="subtle"
          size="icon"
          data-testid={testId}
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "size-8 rounded-lg [&_svg]:size-4",
            destructive &&
              "hover:bg-destructive/10 hover:text-destructive-text",
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function GroupBookmarksDialog({
  isOpen,
  onClose,
  groupId,
  groupName,
  onBookmarksSaved,
}: GroupBookmarksDialogProps) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<BookmarkRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The row just added, whose title field takes focus. */
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const animate = useEntityMotion();

  useEffect(() => {
    if (!isOpen || !groupId) return;
    setError(null);
    setIsLoading(true);
    void invoke<GroupBookmark[]>("get_group_bookmarks", { groupId })
      .then((bookmarks) => {
        setRows(toRows(bookmarks));
      })
      .catch((err: unknown) => {
        console.error("Failed to load group bookmarks:", err);
        setError(translateBackendError(t, err));
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [isOpen, groupId, t]);

  const updateRow = useCallback(
    (key: string, field: keyof GroupBookmark, value: string) => {
      setRows((current) =>
        current.map((row) =>
          row.key === key ? { ...row, [field]: value } : row,
        ),
      );
    },
    [],
  );

  const moveRow = useCallback((index: number, delta: number) => {
    setRows((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!groupId) return;
    setIsSaving(true);
    setError(null);
    try {
      const bookmarks: GroupBookmark[] = rows.map((row) => ({
        title: row.title,
        url: row.url,
        folder: row.folder?.trim() ? row.folder.trim() : null,
      }));
      const saved = await invoke<GroupBookmark[]>("set_group_bookmarks", {
        groupId,
        bookmarks,
      });
      setRows(toRows(saved));

      // Push the edit to the group's stopped profiles now instead of making
      // everyone wait for their next launch. Best effort on purpose: a profile
      // that refuses the write (it just started, its file is unreadable) picks
      // the change up on launch anyway, and the save itself already succeeded.
      const members = await invoke<BrowserProfile[]>("list_browser_profiles");
      await Promise.allSettled(
        members
          .filter((profile) => profile.group_id === groupId)
          .map((profile) =>
            invoke("apply_group_bookmarks_to_profile", {
              profileId: profile.id,
            }),
          ),
      );

      showSuccessToast(t("groupBookmarks.saved"));
      onBookmarksSaved();
      onClose();
    } catch (err) {
      console.error("Failed to save group bookmarks:", err);
      setError(translateBackendError(t, err));
    } finally {
      setIsSaving(false);
    }
  }, [groupId, rows, onBookmarksSaved, onClose, t]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>
            {t("groupBookmarks.title", { name: groupName })}
          </DialogTitle>
          <DialogDescription>
            {t("groupBookmarks.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">
              {t("common.buttons.loading")}
            </p>
          ) : rows.length === 0 ? (
            <p className="flex items-center gap-2 rounded-xl bg-foreground/3 px-3 py-4 text-sm text-muted-foreground">
              <LuBookmark aria-hidden="true" className="size-4 shrink-0" />
              {t("groupBookmarks.empty")}
            </p>
          ) : (
            <div className="space-y-2" data-testid="group-bookmark-rows">
              <AnimatePresence initial={false}>
                {rows.map((row, index) => (
                  <motion.div
                    key={row.key}
                    data-testid="group-bookmark-row"
                    layout={animate ? "position" : false}
                    initial={animate ? { opacity: 0, y: -4 } : false}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{
                      opacity: 0,
                      transition: { duration: animate ? 0.12 : 0 },
                    }}
                    transition={{
                      duration: 0.18,
                      ease: MOTION_EASE_OUT,
                      layout: MOTION_SPRING_POSITION,
                    }}
                    className="flex items-end gap-2 rounded-xl bg-foreground/3 p-3"
                  >
                    <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-3">
                      <div className="space-y-1">
                        <Label
                          htmlFor={`${row.key}-title`}
                          className="text-xs text-muted-foreground"
                        >
                          {t("groupBookmarks.titleColumn")}
                        </Label>
                        <Input
                          id={`${row.key}-title`}
                          variant="soft"
                          data-testid="group-bookmark-title"
                          value={row.title}
                          autoFocus={row.key === focusKey}
                          placeholder={t("groupBookmarks.titlePlaceholder")}
                          onChange={(event) => {
                            updateRow(row.key, "title", event.target.value);
                          }}
                          disabled={isSaving}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label
                          htmlFor={`${row.key}-url`}
                          className="text-xs text-muted-foreground"
                        >
                          {t("groupBookmarks.urlColumn")}
                        </Label>
                        <Input
                          id={`${row.key}-url`}
                          variant="soft"
                          data-testid="group-bookmark-url"
                          value={row.url}
                          placeholder={t("groupBookmarks.urlPlaceholder")}
                          onChange={(event) => {
                            updateRow(row.key, "url", event.target.value);
                          }}
                          disabled={isSaving}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label
                          htmlFor={`${row.key}-folder`}
                          className="text-xs text-muted-foreground"
                        >
                          {t("groupBookmarks.folderColumn")}
                        </Label>
                        <Input
                          id={`${row.key}-folder`}
                          variant="soft"
                          data-testid="group-bookmark-folder"
                          value={row.folder ?? ""}
                          placeholder={t("groupBookmarks.folderPlaceholder")}
                          onChange={(event) => {
                            updateRow(row.key, "folder", event.target.value);
                          }}
                          disabled={isSaving}
                        />
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-0.5">
                      <RowButton
                        testId="group-bookmark-move-up"
                        label={t("groupBookmarks.moveUp")}
                        disabled={index === 0 || isSaving}
                        onClick={() => {
                          moveRow(index, -1);
                        }}
                      >
                        <LuChevronUp />
                      </RowButton>
                      <RowButton
                        testId="group-bookmark-move-down"
                        label={t("groupBookmarks.moveDown")}
                        disabled={index === rows.length - 1 || isSaving}
                        onClick={() => {
                          moveRow(index, 1);
                        }}
                      >
                        <LuChevronDown />
                      </RowButton>
                      <RowButton
                        testId="group-bookmark-remove"
                        label={t("groupBookmarks.removeRow")}
                        destructive
                        disabled={isSaving}
                        onClick={() => {
                          setRows((current) =>
                            current.filter((item) => item.key !== row.key),
                          );
                        }}
                      >
                        <LuTrash2 />
                      </RowButton>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}

          <RippleButton
            variant="soft"
            size="sm"
            data-testid="group-bookmark-add"
            disabled={isSaving}
            onClick={() => {
              const key = newKey();
              setFocusKey(key);
              setRows((current) => [
                ...current,
                { key, title: "", url: "", folder: "" },
              ]);
            }}
            className="flex items-center gap-2"
          >
            <GoPlus className="size-4" />
            {t("groupBookmarks.addRow")}
          </RippleButton>

          {error && (
            <div
              role="alert"
              className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive-text"
            >
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <RippleButton variant="outline" onClick={onClose} disabled={isSaving}>
            {t("common.buttons.cancel")}
          </RippleButton>
          <LoadingButton
            isLoading={isSaving}
            data-testid="group-bookmark-save"
            onClick={() => void handleSave()}
          >
            {t("common.buttons.save")}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
