"use client";

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuTriangleAlert } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EphemeralStorageStatus {
  in_memory: boolean;
  reason: "winfsp_missing" | "winfsp_error" | null;
}

const WINFSP_DOWNLOAD_URL = "https://winfsp.dev/rel/";

/** Shown when this computer cannot keep ephemeral profiles in memory. */
export function EphemeralStorageNotice({ className }: { className?: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<EphemeralStorageStatus | null>(null);

  useEffect(() => {
    let active = true;
    invoke<EphemeralStorageStatus>("get_ephemeral_storage_status")
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((error: unknown) => {
        console.error("Failed to read ephemeral storage status", error);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!status || status.in_memory) return null;

  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2 text-xs text-warning-text",
        className,
      )}
    >
      <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p>
        {t(
          status.reason === "winfsp_error"
            ? "ephemeralStorage.winfspError"
            : "ephemeralStorage.onDisk",
        )}{" "}
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-xs"
          onClick={() => void openUrl(WINFSP_DOWNLOAD_URL)}
        >
          {t("ephemeralStorage.download")}
        </Button>
      </p>
    </div>
  );
}
