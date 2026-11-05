"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LuLayoutGrid } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { ProBadge } from "@/components/ui/pro-badge";
import { useProfilePreviews } from "@/hooks/use-profile-previews";
import { showProfileWindow } from "@/lib/agent-console";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { BrowserProfile } from "@/types";

const PRICING_URL = "https://donutbrowser.com/pricing";

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
  const previews = useProfilePreviews(
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
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-x-4 gap-y-5">
            {running.map((profile) => {
              const preview = previews[profile.id];
              return (
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
                      "group flex w-full cursor-pointer flex-col gap-2 rounded-xl text-left",
                      FOCUS_RING,
                    )}
                  >
                    <span className="relative block aspect-[16/10] w-full overflow-hidden rounded-xl bg-foreground/5">
                      {preview ? (
                        // biome-ignore lint/performance/noImgElement: base64 data URI previews cannot use next/image
                        <img
                          src={preview.image}
                          alt=""
                          className="size-full object-cover object-top transition-transform duration-300 ease-out group-hover:scale-[1.02] motion-reduce:transition-none"
                        />
                      ) : (
                        <span className="block size-full animate-pulse bg-foreground/5 motion-reduce:animate-none" />
                      )}
                    </span>
                    <span className="flex min-w-0 items-baseline gap-2 px-0.5">
                      <span className="truncate text-sm font-medium">
                        {profile.name}
                      </span>
                      {preview?.host && (
                        <span className="truncate text-xs text-muted-foreground">
                          {preview.host}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
