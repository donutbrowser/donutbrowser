"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { LuTriangleAlert } from "react-icons/lu";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { Button } from "@/components/ui/button";
import { translateBackendError } from "@/lib/backend-errors";
import { formatBytes } from "@/lib/format-bytes";
import {
  deleteSiteStorageBackup,
  getSiteStorage,
  repairSiteStorage,
  type SiteStorage,
  type SiteStorageBackup,
  type SiteStorageReport,
  siteLabel,
} from "@/lib/site-storage";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { BrowserProfile } from "@/types";

/**
 * Oversized site data of a profile, with the repair, and the data earlier
 * repairs moved aside, with its delete. Shows nothing for a healthy profile.
 */
export function SiteStoragePanel({
  profile,
  isRunning,
}: {
  profile: BrowserProfile;
  isRunning: boolean;
}) {
  const { t } = useTranslation();
  const [report, setReport] = React.useState<SiteStorageReport | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<SiteStorageBackup | null>(null);

  // A browser that stops may have grown a site, so measure again then.
  React.useEffect(() => {
    if (isRunning) return;
    let cancelled = false;
    getSiteStorage(profile.id)
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch(() => {
        // Nothing to show: the measurement is advice, not a state to fix.
      });
    return () => {
      cancelled = true;
    };
  }, [profile.id, isRunning]);

  if (!report || (report.oversized.length === 0 && report.backups.length === 0))
    return null;

  const repair = async (site: SiteStorage) => {
    setBusy(site.id);
    try {
      setReport(await repairSiteStorage(profile.id, [site.id]));
      showSuccessToast(t("siteStorage.repaired", { site: siteLabel(t, site) }));
    } catch (err) {
      showErrorToast(translateBackendError(t, err));
    } finally {
      setBusy(null);
    }
  };

  const deleteBackup = async (backup: SiteStorageBackup) => {
    setBusy(backup.id);
    try {
      setReport(await deleteSiteStorageBackup(profile.id, backup.id));
      showSuccessToast(t("siteStorage.deleted"));
      setConfirm(null);
    } catch (err) {
      showErrorToast(translateBackendError(t, err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-slot="site-storage" className="flex flex-col gap-2">
      {report.oversized.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg bg-warning/10 px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <LuTriangleAlert className="size-4 shrink-0 text-warning" />
            {t("siteStorage.title")}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("siteStorage.description", {
              size: formatBytes(report.threshold_bytes),
            })}
          </p>
          {report.oversized.map((site) => (
            <div
              key={site.id}
              data-slot="site-storage-oversized"
              data-storage-id={site.id}
              className="flex items-center gap-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" title={siteLabel(t, site)}>
                  {siteLabel(t, site)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(`siteStorage.kinds.${site.kind}`)} ·{" "}
                  {formatBytes(site.bytes)}
                </p>
              </div>
              <Button
                variant="soft"
                size="sm"
                data-slot="site-storage-repair"
                disabled={isRunning || busy !== null}
                title={isRunning ? t("siteStorage.stopFirst") : undefined}
                onClick={() => void repair(site)}
              >
                {t("siteStorage.repair")}
              </Button>
            </div>
          ))}
          {isRunning && (
            <p className="text-xs text-muted-foreground">
              {t("siteStorage.stopFirst")}
            </p>
          )}
        </div>
      )}

      {report.backups.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg bg-foreground/5 px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">
            {t("siteStorage.backupsTitle")}
          </p>
          {report.backups.map((backup) => (
            <div
              key={backup.id}
              data-slot="site-storage-backup"
              data-storage-id={backup.id}
              className="flex items-center gap-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" title={siteLabel(t, backup)}>
                  {siteLabel(t, backup)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {backup.created_at
                    ? t("siteStorage.backupMeta", {
                        size: formatBytes(backup.bytes),
                        date: new Date(backup.created_at * 1000).toLocaleString(
                          undefined,
                          {
                            dateStyle: "medium",
                            timeStyle: "short",
                          },
                        ),
                      })
                    : formatBytes(backup.bytes)}
                </p>
              </div>
              <Button
                variant="soft"
                size="sm"
                data-slot="site-storage-delete-backup"
                disabled={busy !== null}
                onClick={() => setConfirm(backup)}
              >
                {t("common.buttons.delete")}
              </Button>
            </div>
          ))}
        </div>
      )}

      <DeleteConfirmationDialog
        isOpen={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => (confirm ? deleteBackup(confirm) : undefined)}
        title={t("siteStorage.deleteTitle", {
          site: confirm ? siteLabel(t, confirm) : "",
        })}
        description={t("siteStorage.deleteDescription", {
          size: confirm ? formatBytes(confirm.bytes) : "",
        })}
        confirmButtonText={t("common.buttons.delete")}
        isLoading={busy !== null}
      />
    </div>
  );
}
