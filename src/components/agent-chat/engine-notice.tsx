"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuDownload, LuX } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast } from "@/lib/toast-utils";

interface DownloadProgress {
  browser: string;
  version: string;
  percentage: number;
  stage: string;
}

/**
 * A Wayfern newer than the installed one, and its download while it runs.
 * Donut also installs it on its own; this only lets the person go first.
 */
function useWayfernUpdate() {
  const { t } = useTranslation();
  const [available, setAvailable] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      invoke<{ stable?: string | null }>("get_browser_release_types", {
        browserStr: "wayfern",
      }),
      invoke<string[]>("get_downloaded_browser_versions", {
        browserStr: "wayfern",
      }),
    ])
      .then(([latest, installed]) => {
        if (cancelled) return;
        const version = latest.stable ?? null;
        setAvailable(version && !installed.includes(version) ? version : null);
      })
      .catch((error: unknown) => {
        console.warn("Failed to read the Wayfern versions:", error);
      });
    const unlisten = listen<DownloadProgress>("download-progress", (event) => {
      if (event.payload.browser !== "wayfern") return;
      const { stage, percentage } = event.payload;
      if (stage === "completed") {
        setProgress(null);
        setAvailable(null);
      } else if (stage === "error" || stage === "cancelled") {
        setProgress(null);
      } else {
        setProgress(Math.round(percentage));
      }
    });
    return () => {
      cancelled = true;
      void unlisten.then((off) => {
        off();
      });
    };
  }, []);

  const install = async () => {
    if (!available) return;
    setProgress(0);
    try {
      await invoke("download_browser", {
        browserStr: "wayfern",
        version: available,
      });
      await invoke("complete_browser_update_with_auto_update", {
        browser: "wayfern",
        newVersion: available,
      });
    } catch (error) {
      setProgress(null);
      showErrorToast(translateBackendError(t, error));
    }
  };

  return { available, progress, install };
}

/**
 * Why a send waits: the installed Wayfern has no agent yet. The words stay
 * in the box, so the person sends them once the update is in.
 */
export function EngineNotice({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  const { available, progress, install } = useWayfernUpdate();
  const updating = progress !== null;
  return (
    <div
      role="status"
      data-slot="agent-engine-missing"
      className="flex items-start gap-3 rounded-2xl bg-primary/8 py-3 pr-2 pl-3.5"
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/12 text-primary">
        <LuDownload className="size-3.5" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
        <p className="text-sm font-medium">{t("agent.engine.title")}</p>
        <p className="text-xs leading-5 text-muted-foreground">
          {updating
            ? t("agent.engine.updating", { percent: progress })
            : available
              ? t("agent.engine.updateReady")
              : t("agent.engine.body")}
        </p>
        {updating && (
          <span
            role="progressbar"
            aria-label={t("agent.engine.updateAction")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            className="mt-1.5 h-1 w-full max-w-60 overflow-hidden rounded-full bg-foreground/8"
          >
            <span
              className="block h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${progress}%` }}
            />
          </span>
        )}
      </div>
      {available && !updating && (
        <Button
          type="button"
          size="sm"
          data-slot="agent-engine-update"
          className="h-8 shrink-0 rounded-xl text-xs"
          onClick={() => void install()}
        >
          {t("agent.engine.updateAction")}
        </Button>
      )}
      <Button
        type="button"
        variant="subtle"
        size="sm"
        aria-label={t("common.buttons.close")}
        title={t("common.buttons.close")}
        data-slot="agent-engine-dismiss"
        className="size-8 shrink-0 rounded-xl p-0 text-muted-foreground"
        onClick={onDismiss}
      >
        <LuX className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}
