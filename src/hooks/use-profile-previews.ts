import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

/** What one profile's window shows: a JPEG data URL and the page's host. */
export interface ProfilePreview {
  image: string;
  host: string;
}

/** Time between two pictures of one window. */
const REFRESH_MS = 3000;

/**
 * The latest picture of each profile's window, while the app is in view. A
 * profile that stops keeps its last picture until it leaves the list.
 */
export function useProfilePreviews(profileIds: string[], enabled: boolean) {
  const [previews, setPreviews] = useState<Record<string, ProfilePreview>>({});
  const key = profileIds.join(",");

  useEffect(() => {
    if (!enabled) return;
    const ids = key ? key.split(",") : [];
    let active = true;
    let timer = 0;
    const refresh = async () => {
      if (document.visibilityState === "visible" && ids.length > 0) {
        const shots = await Promise.all(
          ids.map((id) =>
            invoke<ProfilePreview | null>("capture_profile_preview", {
              profileId: id,
            }).catch(() => null),
          ),
        );
        if (!active) return;
        setPreviews((previous) => {
          const next: Record<string, ProfilePreview> = {};
          ids.forEach((id, index) => {
            const shot = shots[index] ?? previous[id];
            if (shot) next[id] = shot;
          });
          return next;
        });
      }
      if (active) timer = window.setTimeout(refresh, REFRESH_MS);
    };
    void refresh();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [key, enabled]);

  return previews;
}
