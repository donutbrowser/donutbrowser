"use client";

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuLock, LuLockKeyhole } from "react-icons/lu";
import { LoadingButton } from "@/components/loading-button";
import {
  RowIcon,
  RuleCheck,
  SettingRow,
  SettingsCard,
} from "@/components/settings/settings-primitives";
import { AnimatedDisclosureContent } from "@/components/ui/animated-disclosure";
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
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";

const MIN_PASSWORD_LENGTH = 8;

/** The sync encryption password: set, check, change or remove it. */
export function EncryptionSettings({
  canUseEncryption,
  hasPassword,
  onHasPasswordChange,
}: {
  canUseEncryption: boolean;
  hasPassword: boolean;
  onHasPasswordChange: (hasPassword: boolean) => void;
}) {
  const { t } = useTranslation();
  const [changing, setChanging] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isVerifyOpen, setIsVerifyOpen] = useState(false);
  const [verifyPassword, setVerifyPassword] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);

  const longEnough = password.length >= MIN_PASSWORD_LENGTH;
  const matches = password.length > 0 && password === confirm;
  const showForm = !hasPassword || changing;

  // Every path awaits the rollover so a failed re-sync is shown, not lost.
  const rollover = useCallback(
    async (context: string) => {
      try {
        await invoke("rollover_encryption_for_all_entities");
      } catch (rolloverErr) {
        console.error(`Rollover after ${context} failed:`, rolloverErr);
        showErrorToast(translateBackendError(t, rolloverErr));
      }
    },
    [t],
  );

  const savePassword = async () => {
    if (!longEnough) {
      setError(t("settings.encryption.passwordTooShort"));
      return;
    }
    if (!matches) {
      setError(t("settings.encryption.passwordMismatch"));
      return;
    }
    setIsSaving(true);
    try {
      await invoke("set_e2e_password", { password });
      onHasPasswordChange(true);
      setChanging(false);
      setPassword("");
      setConfirm("");
      await rollover("password set");
      showSuccessToast(t("settings.encryption.passwordSaved"));
    } catch (err) {
      showErrorToast(translateBackendError(t, err));
    } finally {
      setIsSaving(false);
    }
  };

  const removePassword = async () => {
    setIsRemoving(true);
    try {
      await invoke("delete_e2e_password");
      onHasPasswordChange(false);
      setChanging(false);
      await rollover("password removal");
      showSuccessToast(t("settings.encryption.removed"));
    } catch (err) {
      showErrorToast(translateBackendError(t, err));
    } finally {
      setIsRemoving(false);
    }
  };

  const verify = async () => {
    setIsVerifying(true);
    try {
      const ok = await invoke<boolean>("verify_e2e_password", {
        password: verifyPassword,
      });
      if (ok) {
        showSuccessToast(t("settings.encryption.validateDialog.matchToast"));
        setIsVerifyOpen(false);
        setVerifyPassword("");
      } else {
        showErrorToast(t("settings.encryption.validateDialog.mismatchToast"));
      }
    } catch (err) {
      showErrorToast(translateBackendError(t, err));
    } finally {
      setIsVerifying(false);
    }
  };

  if (!canUseEncryption) {
    return (
      <SettingsCard>
        <SettingRow
          icon={
            <RowIcon>
              <LuLock />
            </RowIcon>
          }
          label={t("settings.encryption.noPassword")}
          description={t("settings.encryption.requiresProOrOwner")}
        />
      </SettingsCard>
    );
  }

  return (
    <>
      <SettingsCard>
        <SettingRow
          slot="settings-encryption-status"
          icon={
            <RowIcon tone={hasPassword ? "success" : "muted"}>
              {hasPassword ? <LuLockKeyhole /> : <LuLock />}
            </RowIcon>
          }
          label={
            hasPassword
              ? t("settings.encryption.passwordSetDescription")
              : t("settings.encryption.noPassword")
          }
          description={t("settings.encryption.description")}
        >
          {hasPassword && (
            <>
              <Button
                variant="soft"
                size="sm"
                disabled={isRemoving}
                onClick={() => {
                  setVerifyPassword("");
                  setIsVerifyOpen(true);
                }}
              >
                {t("settings.encryption.validatePassword")}
              </Button>
              <Button
                variant="soft"
                size="sm"
                disabled={isRemoving}
                aria-expanded={changing}
                onClick={() => {
                  setChanging((open) => !open);
                  setPassword("");
                  setConfirm("");
                  setError("");
                }}
              >
                {t("settings.encryption.changePassword")}
              </Button>
              <LoadingButton
                variant="soft"
                size="sm"
                className="h-8 text-destructive-text hover:bg-destructive/10"
                isLoading={isRemoving}
                onClick={() => {
                  void removePassword();
                }}
              >
                {t("settings.encryption.removePassword")}
              </LoadingButton>
            </>
          )}
        </SettingRow>
        <AnimatedDisclosureContent open={showForm}>
          <form
            className="flex flex-col gap-3 px-4 py-3.5"
            onSubmit={(event) => {
              event.preventDefault();
              void savePassword();
            }}
          >
            <div className="grid gap-2 @lg:grid-cols-2">
              <Input
                type="password"
                variant="soft"
                autoComplete="new-password"
                aria-label={t("settings.encryption.passwordPlaceholder")}
                placeholder={t("settings.encryption.passwordPlaceholder")}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError("");
                }}
              />
              <Input
                type="password"
                variant="soft"
                autoComplete="new-password"
                aria-label={t("settings.encryption.confirmPlaceholder")}
                placeholder={t("settings.encryption.confirmPlaceholder")}
                value={confirm}
                onChange={(event) => {
                  setConfirm(event.target.value);
                  setError("");
                }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                <RuleCheck
                  done={longEnough}
                  label={t("settings.encryption.ruleLength", {
                    min: MIN_PASSWORD_LENGTH,
                  })}
                />
                <RuleCheck
                  done={matches}
                  label={t("settings.encryption.ruleMatch")}
                />
              </ul>
              <div className="ml-auto flex items-center gap-2">
                {changing && (
                  <Button
                    type="button"
                    variant="subtle"
                    size="sm"
                    onClick={() => setChanging(false)}
                  >
                    {t("common.buttons.cancel")}
                  </Button>
                )}
                <LoadingButton
                  type="submit"
                  size="sm"
                  className="h-8"
                  isLoading={isSaving}
                  disabled={!longEnough || !matches}
                >
                  {t("settings.encryption.setPassword")}
                </LoadingButton>
              </div>
            </div>
            {error && (
              <p role="alert" className="text-xs text-destructive-text">
                {error}
              </p>
            )}
          </form>
        </AnimatedDisclosureContent>
      </SettingsCard>

      <Dialog
        open={isVerifyOpen}
        onOpenChange={(open) => {
          if (isVerifying) return;
          setIsVerifyOpen(open);
          if (!open) setVerifyPassword("");
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("settings.encryption.validateDialog.title")}
            </DialogTitle>
            <DialogDescription>
              {t("settings.encryption.validateDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <form
            id="settings-verify-e2e"
            onSubmit={(event) => {
              event.preventDefault();
              if (verifyPassword.length > 0) void verify();
            }}
          >
            <Input
              type="password"
              placeholder={t("settings.encryption.passwordPlaceholder")}
              value={verifyPassword}
              autoFocus
              onChange={(event) => setVerifyPassword(event.target.value)}
            />
          </form>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isVerifying}
              onClick={() => {
                setIsVerifyOpen(false);
                setVerifyPassword("");
              }}
            >
              {t("common.buttons.cancel")}
            </Button>
            <LoadingButton
              type="submit"
              form="settings-verify-e2e"
              isLoading={isVerifying}
              disabled={verifyPassword.length === 0}
            >
              {t("settings.encryption.validateDialog.submit")}
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
