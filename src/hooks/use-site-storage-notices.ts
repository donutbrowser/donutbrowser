"use client";

import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { translateBackendError } from "@/lib/backend-errors";
import { formatBytes } from "@/lib/format-bytes";
import {
  repairSiteStorage,
  type SiteStorage,
  siteLabel,
} from "@/lib/site-storage";
import { showErrorToast, showSuccessToast, showToast } from "@/lib/toast-utils";
import type { BrowserProfile } from "@/types";

interface OversizedNotice {
  profile_id: string;
  sites: SiteStorage[];
}

/**
 * A browser quit soon after its launch while a site's data was oversized:
 * one toast per profile that names the sites and offers the repair.
 */
export function useSiteStorageNotices(profiles: readonly BrowserProfile[]) {
  const { t } = useTranslation();
  const latest = useRef({ t, profiles });
  latest.current = { t, profiles };

  useEffect(() => {
    let disposed = false;
    const unlisten = listen<OversizedNotice>(
      "site-storage-oversized",
      (event) => {
        if (disposed) return;
        const { profile_id, sites } = event.payload;
        if (sites.length === 0) return;
        const { t: translate, profiles: known } = latest.current;
        const name =
          known.find((profile) => profile.id === profile_id)?.name ??
          translate("common.labels.unknownProfile");
        const site = sites.map((s) => siteLabel(translate, s)).join(", ");
        const size = formatBytes(sites.reduce((sum, s) => sum + s.bytes, 0));
        const id = `site-storage-${profile_id}`;
        showToast({
          type: "error",
          id,
          duration: Number.POSITIVE_INFINITY,
          title: translate("siteStorage.notice.title", { name, site, size }),
          description: translate("siteStorage.notice.description"),
          action: {
            label: translate("siteStorage.repair"),
            onClick: () => {
              repairSiteStorage(
                profile_id,
                sites.map((s) => s.id),
              )
                .then(() =>
                  showSuccessToast(
                    translate("siteStorage.repaired", { site }),
                    { id },
                  ),
                )
                .catch((err: unknown) =>
                  showErrorToast(translateBackendError(translate, err), {
                    id,
                  }),
                );
            },
          },
        });
      },
    );
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);
}
