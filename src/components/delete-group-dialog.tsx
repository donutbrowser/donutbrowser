"use client";

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LoadingButton } from "@/components/loading-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { translateBackendError } from "@/lib/backend-errors";
import { cn } from "@/lib/utils";
import type { BrowserProfile, ProfileGroup } from "@/types";
import { RippleButton } from "./ui/ripple";

interface DeleteGroupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  group: ProfileGroup | null;
  onGroupDeleted: () => void;
}

export function DeleteGroupDialog({
  isOpen,
  onClose,
  group,
  onGroupDeleted,
}: DeleteGroupDialogProps) {
  const { t } = useTranslation();
  const [associatedProfiles, setAssociatedProfiles] = useState<
    BrowserProfile[]
  >([]);
  const [deleteAction, setDeleteAction] = useState<"move" | "delete">("move");
  const [isDeleting, setIsDeleting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAssociatedProfiles = useCallback(async () => {
    if (!group) return;

    setIsLoading(true);
    setError(null);
    try {
      const allProfiles = await invoke<BrowserProfile[]>(
        "list_browser_profiles",
      );
      const groupProfiles = allProfiles.filter(
        (profile) => profile.group_id === group.id,
      );
      setAssociatedProfiles(groupProfiles);
    } catch (err) {
      console.error("Failed to load associated profiles:", err);
      setError(
        err instanceof Error ? err.message : t("groups.loadProfilesFailed"),
      );
    } finally {
      setIsLoading(false);
    }
  }, [group, t]);

  useEffect(() => {
    if (isOpen && group) {
      void loadAssociatedProfiles();
    }
  }, [isOpen, group, loadAssociatedProfiles]);

  const handleDelete = useCallback(async () => {
    if (!group) return;

    setIsDeleting(true);
    setError(null);
    try {
      if (deleteAction === "delete" && associatedProfiles.length > 0) {
        // Delete all associated profiles first
        const profileIds = associatedProfiles.map((p) => p.id);
        await invoke("delete_selected_profiles", { profileIds });
      } else if (deleteAction === "move" && associatedProfiles.length > 0) {
        // Move profiles to default group (null group_id)
        const profileIds = associatedProfiles.map((p) => p.id);
        await invoke("assign_profiles_to_group", {
          profileIds,
          groupId: null,
        });
      }

      // Delete the group
      await invoke("delete_profile_group", { groupId: group.id });

      toast.success(t("groups.deleteSuccess"));
      onGroupDeleted();
      onClose();
    } catch (err) {
      console.error("Failed to delete group:", err);
      const errorMessage = translateBackendError(t, err);
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsDeleting(false);
    }
  }, [group, deleteAction, associatedProfiles, onGroupDeleted, onClose, t]);

  const handleClose = useCallback(() => {
    setError(null);
    setDeleteAction("move");
    setAssociatedProfiles([]);
    onClose();
  }, [onClose]);

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("groups.deleteTitle")}</DialogTitle>
          <DialogDescription>{t("groups.deleteDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isLoading ? (
            <div className="text-sm text-muted-foreground">
              {t("groups.loadingProfiles")}
            </div>
          ) : associatedProfiles.length > 0 ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>
                  {t("groups.associatedProfiles", {
                    count: associatedProfiles.length,
                  })}
                </Label>
                <ScrollArea className="max-h-[min(8rem,25vh)] w-full overflow-y-auto rounded-xl bg-foreground/3 p-1">
                  <ul className="space-y-0.5">
                    {associatedProfiles.map((profile) => (
                      <li
                        key={profile.id}
                        className="truncate rounded-md px-2 py-1 text-sm"
                      >
                        {profile.name}
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              </div>

              <div className="space-y-2">
                <Label>{t("groups.whatToDoWithProfiles")}</Label>
                <RadioGroup
                  value={deleteAction}
                  onValueChange={(value) => {
                    setDeleteAction(value as "move" | "delete");
                  }}
                  className="gap-1.5"
                >
                  {(["move", "delete"] as const).map((action) => (
                    <Label
                      key={action}
                      htmlFor={`delete-group-${action}`}
                      data-state={
                        deleteAction === action ? "checked" : "unchecked"
                      }
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-normal transition-colors duration-150",
                        deleteAction !== action
                          ? "bg-foreground/3 hover:bg-foreground/5"
                          : action === "delete"
                            ? "bg-destructive/10 text-destructive-text"
                            : "bg-primary/10",
                      )}
                    >
                      <RadioGroupItem
                        value={action}
                        id={`delete-group-${action}`}
                      />
                      {action === "move"
                        ? t("groups.moveToDefault")
                        : t("groups.deleteAlongWithGroup")}
                    </Label>
                  ))}
                </RadioGroup>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              {t("groups.noAssociatedProfiles")}
            </div>
          )}

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
          <RippleButton
            variant="outline"
            onClick={handleClose}
            disabled={isDeleting}
          >
            {t("common.buttons.cancel")}
          </RippleButton>
          <LoadingButton
            variant="destructive"
            isLoading={isDeleting}
            onClick={() => void handleDelete()}
            disabled={isLoading}
          >
            {deleteAction === "delete" && associatedProfiles.length > 0
              ? t("groups.deleteGroupAndProfiles")
              : t("groups.deleteGroup")}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
