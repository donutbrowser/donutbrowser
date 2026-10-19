"use client";

import { invoke } from "@tauri-apps/api/core";
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  LuCloud,
  LuCopy,
  LuFolderInput,
  LuInfo,
  LuLock,
  LuPencil,
  LuPlay,
  LuSquare,
  LuSquareStack,
  LuTrash2,
} from "react-icons/lu";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import { keyToken } from "@/lib/shortcuts";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { BrowserProfile } from "@/types";

export interface RowMenuActions {
  isRunning: boolean;
  /** Launch or stop is possible right now. */
  canToggleRun: boolean;
  canRename: boolean;
  canTrash: boolean;
  onToggleRun: () => void;
  onOpenDetails: () => void;
  onRename: () => void;
  onDuplicate?: () => void;
  onMoveToGroup?: () => void;
  onRunRemote?: () => void;
  onLockNow?: () => void;
  onTrash?: () => void;
}

/**
 * Whether a password-protected profile is unlocked on this device right
 * now. Only then is "Lock now" an action.
 */
function useUnlocked(profile: BrowserProfile, enabled: boolean) {
  const [unlocked, setUnlocked] = React.useState(false);
  React.useEffect(() => {
    if (!enabled || !profile.password_protected) {
      setUnlocked(false);
      return;
    }
    let active = true;
    invoke<boolean>("is_profile_locked", { profileId: profile.id })
      .then((locked) => {
        if (active) setUnlocked(!locked);
      })
      .catch(() => {
        if (active) setUnlocked(false);
      });
    return () => {
      active = false;
    };
  }, [enabled, profile.id, profile.password_protected]);
  return unlocked;
}

/** The right-click menu of one profile row. */
export function RowContextMenuContent({
  profile,
  actions,
  onCloseAutoFocus,
}: {
  profile: BrowserProfile;
  actions: RowMenuActions;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useTranslation();
  const unlocked = useUnlocked(profile, Boolean(actions.onLockNow));
  const mod = keyToken("mod").glyph;
  const enter = keyToken("enter").glyph;

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(profile.id);
      showSuccessToast(t("toasts.success.copied"));
    } catch {
      showErrorToast(t("toasts.error.copyFailed"));
    }
  };

  return (
    <ContextMenuContent
      data-slot="profile-row-menu"
      data-profile-id={profile.id}
      className="min-w-52"
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <ContextMenuLabel className="max-w-64">{profile.name}</ContextMenuLabel>
      <ContextMenuItem
        disabled={!actions.canToggleRun}
        onSelect={actions.onToggleRun}
      >
        {actions.isRunning ? (
          <LuSquare className="fill-current" />
        ) : (
          <LuPlay className="fill-current" />
        )}
        {actions.isRunning
          ? t("profiles.actions.stop")
          : t("profiles.actions.launch")}
        <ContextMenuShortcut>{`${mod}${enter}`}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={actions.onOpenDetails}>
        <LuInfo />
        {t("profileTable.menu.openDetails")}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!actions.canRename}
        onSelect={actions.onRename}
      >
        <LuPencil />
        {t("profileTable.menu.rename")}
        <ContextMenuShortcut>F2</ContextMenuShortcut>
      </ContextMenuItem>
      {actions.onDuplicate && (
        <ContextMenuItem onSelect={actions.onDuplicate}>
          <LuSquareStack />
          {t("profileInfo.duplicate")}
        </ContextMenuItem>
      )}
      {actions.onMoveToGroup && (
        <ContextMenuItem onSelect={actions.onMoveToGroup}>
          <LuFolderInput />
          {t("profileTable.menu.moveToGroup")}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => void copyId()}>
        <LuCopy />
        {t("profileTable.menu.copyId")}
      </ContextMenuItem>
      {(actions.onRunRemote || (actions.onLockNow && unlocked)) && (
        <ContextMenuSeparator />
      )}
      {actions.onRunRemote && (
        <ContextMenuItem
          disabled={actions.isRunning}
          onSelect={actions.onRunRemote}
        >
          <LuCloud />
          {t("profileTable.menu.runRemote")}
        </ContextMenuItem>
      )}
      {actions.onLockNow && unlocked && (
        <ContextMenuItem onSelect={actions.onLockNow}>
          <LuLock />
          {t("profileTable.menu.lockNow")}
        </ContextMenuItem>
      )}
      {actions.onTrash && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            disabled={!actions.canTrash}
            onSelect={actions.onTrash}
          >
            <LuTrash2 />
            {t("profileTable.menu.moveToTrash")}
            <ContextMenuShortcut>
              {keyToken("backspace").glyph}
            </ContextMenuShortcut>
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}
