"use client";

import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { showToast } from "@/lib/toast-utils";
import type { BrowserProfile } from "@/types";

/** Something a launch will not do, said while the launch goes on. */
interface LaunchNotice {
  profile_id: string;
  code: string;
}

/**
 * One info toast per launch notice. A second notice for the same profile
 * replaces the first toast, so a retried launch never shows two.
 */
export function useLaunchNotices(profiles: readonly BrowserProfile[]) {
  const { t } = useTranslation();
  const latest = useRef({ t, profiles });
  latest.current = { t, profiles };

  useEffect(() => {
    let disposed = false;
    const unlisten = listen<LaunchNotice>("launch-notice", (event) => {
      if (disposed) return;
      const { profile_id, code } = event.payload;
      const { t: translate, profiles: known } = latest.current;
      if (code !== "FINGERPRINT_EDITS_NOT_APPLIED") return;
      const name =
        known.find((profile) => profile.id === profile_id)?.name ??
        translate("common.labels.unknownProfile");
      showToast({
        type: "info",
        id: `launch-notice-${profile_id}`,
        title: translate("launchNotice.fingerprintEditsNotApplied", { name }),
        description: translate("launchNotice.fingerprintEditsNeedPro"),
      });
    });
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);
}
