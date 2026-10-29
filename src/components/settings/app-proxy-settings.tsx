"use client";

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingButton } from "@/components/loading-button";
import {
  SettingBlock,
  SettingsCard,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { translateBackendError } from "@/lib/backend-errors";
import { showSuccessToast } from "@/lib/toast-utils";

/**
 * The proxy Donut's own connections use: downloads, update checks, sign-in
 * and sync. The backend keeps the URL sealed and returns it without
 * credentials, so a set proxy is replaced, never edited.
 */
export function AppProxyForm() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void invoke<string | null>("get_app_proxy").then(setCurrent);
  }, []);

  const apply = useCallback(
    async (proxy: string | null) => {
      setBusy(true);
      setError(null);
      try {
        const set = await invoke<string | null>("set_app_proxy", { proxy });
        setCurrent(set);
        setEditing(false);
        setValue("");
        showSuccessToast(
          set
            ? t("settings.network.saved", { proxy: set })
            : t("settings.network.removed"),
        );
      } catch (err) {
        setError(translateBackendError(t, err));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  if (current && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {t("settings.network.current", { proxy: current })}
        </span>
        <Button variant="soft" size="sm" onClick={() => setEditing(true)}>
          {t("common.buttons.edit")}
        </Button>
        <LoadingButton
          variant="soft"
          size="sm"
          isLoading={busy}
          onClick={() => void apply(null)}
        >
          {t("common.buttons.clear")}
        </LoadingButton>
        {error && (
          <p role="alert" className="w-full text-xs text-destructive-text">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) void apply(value.trim());
      }}
    >
      <div className="flex gap-2">
        <Input
          variant="soft"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t("settings.network.placeholder")}
          aria-label={t("settings.network.appProxy")}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
        />
        <LoadingButton
          type="submit"
          size="sm"
          isLoading={busy}
          disabled={!value.trim()}
        >
          {t("common.buttons.save")}
        </LoadingButton>
        {current && (
          <Button
            type="button"
            variant="soft"
            size="sm"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
          >
            {t("common.buttons.cancel")}
          </Button>
        )}
      </div>
      <p
        role={error ? "alert" : undefined}
        className={
          error
            ? "text-xs text-destructive-text"
            : "text-xs text-muted-foreground"
        }
      >
        {error ?? t("settings.network.checkNote")}
      </p>
    </form>
  );
}

export function AppProxySettings() {
  const { t } = useTranslation();
  return (
    <SettingsCard>
      <SettingBlock
        label={t("settings.network.appProxy")}
        description={t("settings.network.appProxyDescription")}
      >
        <AppProxyForm />
      </SettingBlock>
    </SettingsCard>
  );
}
