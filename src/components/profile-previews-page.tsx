"use client";

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuAppWindow, LuLayoutGrid } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { ProBadge } from "@/components/ui/pro-badge";
import { showProfileWindow } from "@/lib/agent-console";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { BrowserProfile } from "@/types";

/** Time between two pictures of one window. */
const REFRESH_MS = 3000;
const PRICING_URL = "https://donutbrowser.com/pricing";

/** The latest picture of each running profile, while the page is in view. */
function usePreviews(profileIds: string[], enabled: boolean) {
  const [images, setImages] = useState<Record<string, string>>({});
  const key = profileIds.join(",");

  useEffect(() => {
    if (!enabled) return;
    const ids = key ? key.split(",") : [];
    let active = true;
    let timer = 0;
    const refresh = async () => {
      if (document.visibilityState === "visible") {
        const shots = await Promise.all(
          ids.map((id) =>
            invoke<string | null>("capture_profile_preview", {
              profileId: id,
            }).catch(() => null),
          ),
        );
        if (!active) return;
        setImages((previous) => {
          const next: Record<string, string> = {};
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

  return images;
}

export function ProfilePreviewsPage({
  profiles,
  runningProfileIds,
  unlocked,
}: {
  profiles: BrowserProfile[];
  runningProfileIds: ReadonlySet<string>;
  /** Live previews come with browser automation (Pro and up). */
  unlocked: boolean;
}) {
  const { t } = useTranslation();
  const running = useMemo(
    () =>
      profiles
        .filter((profile) => runningProfileIds.has(profile.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [profiles, runningProfileIds],
  );
  const images = usePreviews(
    running.map((profile) => profile.id),
    unlocked,
  );

  const show = (profile: BrowserProfile) => {
    void showProfileWindow(profile.id).catch((error: unknown) => {
      showErrorToast(translateBackendError(t, error));
    });
  };

  return (
    <div
      data-slot="profile-previews"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-4 pb-8"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <header className="flex min-w-0 flex-col gap-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            {t("previews.title")}
            {!unlocked && <ProBadge />}
          </h1>
          <p className="text-xs text-muted-foreground">
            {t("previews.description")}
          </p>
        </header>

        {!unlocked ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="grid size-12 place-items-center rounded-2xl bg-foreground/5 text-muted-foreground">
              <LuLayoutGrid className="size-6" />
            </span>
            <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
              {t("previews.locked")}
            </p>
            <Button
              variant="soft"
              size="sm"
              onClick={() => void openUrl(PRICING_URL)}
            >
              {t("previews.seePlans")}
            </Button>
          </div>
        ) : running.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {t("previews.empty")}
          </p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
            {running.map((profile) => (
              <li key={profile.id}>
                <button
                  type="button"
                  data-slot="profile-preview"
                  data-profile-id={profile.id}
                  onClick={() => show(profile)}
                  aria-label={t("commandPalette.actions.showWindow", {
                    name: profile.name,
                  })}
                  className={cn(
                    "group flex w-full cursor-pointer flex-col gap-2 rounded-lg p-1.5 text-left transition-colors hover:bg-foreground/5",
                    FOCUS_RING,
                  )}
                >
                  <span className="grid aspect-video w-full place-items-center overflow-hidden rounded-md bg-foreground/5">
                    {images[profile.id] ? (
                      // biome-ignore lint/performance/noImgElement: base64 data URI previews cannot use next/image
                      <img
                        src={images[profile.id]}
                        alt=""
                        className="size-full object-cover object-top"
                      />
                    ) : (
                      <LuAppWindow className="size-5 text-muted-foreground" />
                    )}
                  </span>
                  <span className="truncate px-1 text-sm font-medium">
                    {profile.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
