"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion } from "motion/react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  LuCloud,
  LuCopy,
  LuEllipsis,
  LuLayoutTemplate,
  LuLoaderCircle,
  LuLock,
  LuPlay,
  LuSquare,
  LuTrash2,
} from "react-icons/lu";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCloudAuth } from "@/hooks/use-cloud-auth";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { useSyncPasswordSet } from "@/hooks/use-sync-password";
import { translateBackendError } from "@/lib/backend-errors";
import { getEntitlements } from "@/lib/entitlements";
import { MOTION_SPRING } from "@/lib/motion";
import {
  type RemoteHandoffState,
  startRemoteSession,
} from "@/lib/remote-sessions";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { BrowserProfile } from "@/types";

/**
 * Whether a password-protected profile is open on this device: its key is
 * held, so its data stays decrypted until it is locked again.
 */
export function useProfileUnlocked(
  profile: BrowserProfile,
  isRunning: boolean,
): [boolean, () => void] {
  const [unlocked, setUnlocked] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const protectedProfile = profile.password_protected === true;

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt asks again after a lock, and a stop can leave the key held
  React.useEffect(() => {
    if (!protectedProfile) {
      setUnlocked(false);
      return;
    }
    let current = true;
    const read = () => {
      invoke<boolean>("is_profile_locked", { profileId: profile.id })
        .then((locked) => {
          if (current) setUnlocked(!locked);
        })
        .catch(() => {
          if (current) setUnlocked(false);
        });
    };
    read();
    const unlisten = listen("profiles-changed", read);
    return () => {
      current = false;
      void unlisten.then((stop) => stop());
    };
  }, [profile.id, protectedProfile, isRunning, attempt]);

  return [unlocked, () => setAttempt((n) => n + 1)];
}

/** Seals an unlocked profile again and forgets its key. */
export async function lockProfileNow(
  profile: BrowserProfile,
  t: Parameters<typeof translateBackendError>[0],
): Promise<boolean> {
  try {
    await invoke("lock_profile", { profileId: profile.id });
    showSuccessToast(t("profiles.lockedToast", { name: profile.name }));
    return true;
  } catch (error) {
    showErrorToast(translateBackendError(t, error));
    return false;
  }
}

/**
 * Whether the account and the profile allow opening it on a leased host: a
 * plan with interactive remote sessions, and Regular sync, so the host can
 * pull the profile and hand it back.
 */
export function useCanRunRemote(
  profile: BrowserProfile,
  isRunning: boolean,
  handoffState: RemoteHandoffState | null | undefined,
): boolean {
  const { user } = useCloudAuth();
  const entitlements = getEntitlements(user);
  const syncPasswordSet = useSyncPasswordSet();
  return (
    Boolean(user) &&
    entitlements.active &&
    entitlements.remoteInteractive &&
    profile.browser === "wayfern" &&
    profile.ephemeral !== true &&
    profile.sync_mode === "Regular" &&
    !syncPasswordSet &&
    !isRunning &&
    !handoffState
  );
}

export function RunInCloudButton({ profile }: { profile: BrowserProfile }) {
  const { t } = useTranslation();
  const [starting, setStarting] = React.useState(false);
  const label = t("profileInfo.aria.runRemote", { name: profile.name });

  const start = async () => {
    setStarting(true);
    try {
      await startRemoteSession(profile.id);
      showSuccessToast(t("profiles.remote.starting", { name: profile.name }));
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="subtle"
          size="icon"
          data-slot="profile-info-run-remote"
          aria-label={label}
          className="size-7"
          disabled={starting}
          onClick={() => void start()}
        >
          {starting ? (
            <LuLoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <LuCloud className="size-3.5" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t("profileTable.menu.runRemote")}</TooltipContent>
    </Tooltip>
  );
}

/** Launch or Stop, the same action as the row's launch button. */
export function RunToggleButton({
  profile,
  isRunning,
  isLaunching,
  isStopping,
  canToggle,
  onToggle,
  className,
}: {
  profile: BrowserProfile;
  isRunning: boolean;
  isLaunching: boolean;
  isStopping: boolean;
  canToggle: boolean;
  onToggle: () => void | Promise<unknown>;
  className?: string;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = React.useState(false);
  const busy = pending || isLaunching || isStopping;
  const stop = isRunning || isStopping;

  const run = async () => {
    setPending(true);
    try {
      await onToggle();
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      variant={stop ? "soft" : "default"}
      size="sm"
      data-slot="profile-info-run"
      data-running={isRunning || undefined}
      aria-label={
        stop
          ? t("profileTable.aria.stop", { name: profile.name })
          : t("profileTable.aria.launch", { name: profile.name })
      }
      aria-busy={busy || undefined}
      className={className ?? "h-7 gap-1.5 px-2.5 text-xs"}
      disabled={!canToggle || busy}
      onClick={() => void run()}
    >
      {busy ? (
        <LuLoaderCircle className="size-3.5 animate-spin" />
      ) : stop ? (
        <LuSquare className="size-3 fill-current" />
      ) : (
        <LuPlay className="size-3 fill-current" />
      )}
      {stop ? t("profiles.actions.stop") : t("profiles.actions.launch")}
    </Button>
  );
}

export function ProfileMoreMenu({
  profile,
  onDuplicate,
  duplicateDisabled,
  onSaveTemplate,
  saveTemplateLabel,
  onLock,
  onDelete,
  deleteDisabled,
}: {
  profile: BrowserProfile;
  onDuplicate?: () => void;
  duplicateDisabled?: boolean;
  onSaveTemplate?: () => void;
  saveTemplateLabel?: string;
  onLock?: () => void;
  onDelete?: () => void;
  deleteDisabled?: boolean;
}) {
  const { t } = useTranslation();
  if (!onDuplicate && !onSaveTemplate && !onLock && !onDelete) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="subtle"
          size="icon"
          data-slot="profile-info-more"
          aria-label={t("profileInfo.aria.moreActions", { name: profile.name })}
          className="size-7"
        >
          <LuEllipsis className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {onDuplicate && (
          <DropdownMenuItem
            data-slot="profile-info-duplicate"
            disabled={duplicateDisabled}
            onSelect={onDuplicate}
          >
            <LuCopy />
            {t("profileInfo.duplicate")}
          </DropdownMenuItem>
        )}
        {onSaveTemplate && (
          <DropdownMenuItem
            data-slot="profile-info-save-template"
            onSelect={onSaveTemplate}
          >
            <LuLayoutTemplate />
            {saveTemplateLabel}
          </DropdownMenuItem>
        )}
        {onLock && (
          <DropdownMenuItem data-slot="profile-info-lock" onSelect={onLock}>
            <LuLock />
            {t("profileTable.menu.lockNow")}
          </DropdownMenuItem>
        )}
        {onDelete && (
          <>
            {(onDuplicate || onSaveTemplate || onLock) && (
              <DropdownMenuSeparator />
            )}
            <DropdownMenuItem
              variant="destructive"
              data-slot="profile-info-delete"
              disabled={deleteDisabled}
              onSelect={onDelete}
            >
              <LuTrash2 />
              {t("profileInfo.sections.delete")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Why every field is read-only while the browser runs, with the way out. */
export function RunningBanner({
  profile,
  canStop,
  isStopping,
  onStop,
}: {
  profile: BrowserProfile;
  canStop: boolean;
  isStopping: boolean;
  onStop?: () => void | Promise<unknown>;
}) {
  const { t } = useTranslation();
  const motionAllowed = useMotionAllowed();
  return (
    <motion.div
      role="status"
      data-slot="profile-info-running-banner"
      initial={motionAllowed ? { y: -4 } : false}
      animate={{ y: 0 }}
      transition={MOTION_SPRING.snappy}
      className="mx-3 mb-1 flex shrink-0 items-center gap-2 rounded-lg bg-primary/8 px-3 py-1.5 text-xs"
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-success"
      />
      <span className="min-w-0 flex-1">{t("profileInfo.runningBanner")}</span>
      {onStop && (
        <RunToggleButton
          profile={profile}
          isRunning
          isLaunching={false}
          isStopping={isStopping}
          canToggle={canStop}
          onToggle={onStop}
          className="h-6 gap-1.5 px-2 text-xs"
        />
      )}
    </motion.div>
  );
}
