import { invoke } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";

export type SiteStorageKind =
  | "indexed_db"
  | "cache_storage"
  | "file_system"
  | "storage_bucket";

/** The folders of one site in one kind of storage. */
export interface SiteStorage {
  id: string;
  kind: SiteStorageKind;
  origin: string | null;
  folder: string;
  bytes: number;
}

/** Site folders a repair moved aside, kept until deleted. */
export interface SiteStorageBackup extends SiteStorage {
  created_at: number | null;
}

export interface SiteStorageReport {
  oversized: SiteStorage[];
  backups: SiteStorageBackup[];
  threshold_bytes: number;
}

export function siteLabel(t: TFunction, site: SiteStorage): string {
  return site.origin ?? t("siteStorage.unknownSite", { folder: site.folder });
}

export function getSiteStorage(profileId: string) {
  return invoke<SiteStorageReport>("get_profile_site_storage", { profileId });
}

/** Moves the named sites' folders aside; refused while the browser runs. */
export function repairSiteStorage(profileId: string, storageIds: string[]) {
  return invoke<SiteStorageReport>("repair_profile_site_storage", {
    profileId,
    storageIds,
  });
}

export function deleteSiteStorageBackup(profileId: string, backupId: string) {
  return invoke<SiteStorageReport>("delete_profile_site_storage_backup", {
    profileId,
    backupId,
  });
}
