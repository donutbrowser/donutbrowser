import { invoke } from "@tauri-apps/api/core";
import * as React from "react";
import { useTranslation } from "react-i18next";
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
  extractLockoutSeconds,
  formatLockoutDuration,
  translateBackendError,
} from "@/lib/backend-errors";
import { showErrorToast } from "@/lib/toast-utils";
import type { BrowserProfile } from "@/types";
import { LoadingButton } from "./loading-button";
import { RippleButton } from "./ui/ripple";

interface ProfilePasswordDialogProps {
  isOpen: boolean;
  onClose: () => void;
  profile: BrowserProfile | null;
  onUnlocked?: (profile: BrowserProfile) => void;
}

/** Asks for a protected profile's password so it can launch. Setting,
 * changing and removing the password are in the profile's Security section. */
export function ProfilePasswordDialog({
  isOpen,
  onClose,
  profile,
  onUnlocked,
}: ProfilePasswordDialogProps) {
  const { t } = useTranslation();
  const [password, setPassword] = React.useState("");
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [lockoutSecondsRemaining, setLockoutSecondsRemaining] = React.useState<
    number | null
  >(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    setPassword("");
    setIsSubmitting(false);
    setLockoutSecondsRemaining(null);
    const handle = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(handle);
    };
  }, [isOpen]);

  React.useEffect(() => {
    if (lockoutSecondsRemaining == null) return;
    if (lockoutSecondsRemaining <= 0) {
      setLockoutSecondsRemaining(null);
      return;
    }
    const handle = window.setTimeout(() => {
      setLockoutSecondsRemaining((prev) => (prev == null ? null : prev - 1));
    }, 1000);
    return () => {
      window.clearTimeout(handle);
    };
  }, [lockoutSecondsRemaining]);

  if (!profile) return null;

  const handleSubmit = async () => {
    if (isSubmitting || lockoutSecondsRemaining != null) return;
    if (!password) {
      showErrorToast(t("profilePassword.errors.passwordRequired"));
      return;
    }
    setIsSubmitting(true);
    try {
      await invoke("unlock_profile", { profileId: profile.id, password });
      onUnlocked?.(profile);
      onClose();
    } catch (err: unknown) {
      const lockoutSeconds = extractLockoutSeconds(err);
      if (lockoutSeconds != null) {
        setLockoutSecondsRemaining(lockoutSeconds);
      } else {
        showErrorToast(translateBackendError(t, err));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("profilePassword.unlock.title")}</DialogTitle>
          <DialogDescription>
            {t("profilePassword.unlock.description", { name: profile.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {lockoutSecondsRemaining != null && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive-text">
              {t("backendErrors.lockedOut", {
                duration: formatLockoutDuration(t, lockoutSecondsRemaining),
              })}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="profile-pw-unlock">
              {t("profilePassword.fields.password")}
            </Label>
            <Input
              ref={inputRef}
              id="profile-pw-unlock"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSubmit();
              }}
              disabled={isSubmitting}
              autoComplete="current-password"
            />
          </div>
        </div>
        <DialogFooter>
          <RippleButton
            variant="outline"
            onClick={onClose}
            disabled={isSubmitting}
          >
            {t("common.buttons.cancel")}
          </RippleButton>
          <LoadingButton
            onClick={() => void handleSubmit()}
            isLoading={isSubmitting}
            disabled={lockoutSecondsRemaining != null}
          >
            {t("profilePassword.unlock.button")}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
