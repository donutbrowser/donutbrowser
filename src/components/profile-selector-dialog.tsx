"use client";

import { invoke } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuArrowRight,
  LuFlame,
  LuFolder,
  LuGlobe,
  LuLock,
  LuSearchX,
  LuShieldCheck,
} from "react-icons/lu";
import { LoadingButton } from "@/components/loading-button";
import { ProfileGlyph } from "@/components/profile-glyph";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGlide,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { CopyToClipboard } from "@/components/ui/copy-to-clipboard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusLight } from "@/components/ui/settings-panel";
import { useBrowserState } from "@/hooks/use-browser-state";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { useProfileEvents } from "@/hooks/use-profile-events";
import { useProxyEvents } from "@/hooks/use-proxy-events";
import { useVpnEvents } from "@/hooks/use-vpn-events";
import { translateBackendError } from "@/lib/backend-errors";
import { getOSDisplayName, getOSIcon } from "@/lib/browser-utils";
import { MOTION_SPRING } from "@/lib/motion";
import { paletteScore } from "@/lib/palette-search";
import { showErrorToast } from "@/lib/toast-utils";
import type { BrowserProfile } from "@/types";

interface ProfileSelectorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  isUpdating: (browser: string) => boolean;
  url?: string;
  runningProfiles?: Set<string>;
}

/** The search field shows only when the list is longer than this. */
const SEARCH_FROM = 6;
/** Rows past this one appear at once: a long list does not wait to show. */
const STAGGERED_ROWS = 8;
const NO_IDS = new Set<string>();
const META_ICON = "size-3 shrink-0 text-muted-foreground";

// The glide draws the selection, so a selected row stays transparent.
const ROW_CLASS =
  "gap-3 rounded-lg px-2.5 py-2 data-[selected=true]:bg-transparent data-[selected=true]:text-foreground";

/** The link's host, and the rest of it, to show apart. */
function splitUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (!parsed.host) return { host: url, rest: "" };
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return { host: parsed.host, rest: `${path}${parsed.search}${parsed.hash}` };
  } catch {
    return { host: url, rest: "" };
  }
}

export function ProfileSelectorDialog({
  isOpen,
  onClose,
  url,
  runningProfiles: externalRunningProfiles,
  isUpdating,
}: ProfileSelectorDialogProps) {
  const { t } = useTranslation();
  const motionAllowed = useMotionAllowed();
  const {
    profiles: rawProfiles,
    groups,
    runningProfiles: hookRunningProfiles,
  } = useProfileEvents();
  const profiles = useMemo(
    () =>
      [...rawProfiles].sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      ),
    [rawProfiles],
  );
  const runningProfiles = externalRunningProfiles ?? hookRunningProfiles;
  const { storedProxies } = useProxyEvents();
  const { vpnConfigs } = useVpnEvents();
  const [selectedId, setSelectedId] = useState("");
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [entered, setEntered] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const picked = useRef(false);

  const browserState = useBrowserState(
    profiles,
    runningProfiles,
    isUpdating,
    NO_IDS,
    NO_IDS,
  );

  const selected = profiles.find((profile) => profile.id === selectedId);
  const searching = profiles.length >= SEARCH_FROM;
  const canOpen =
    !!url &&
    !!selected &&
    launchingId === null &&
    browserState.canUseProfileForLinks(selected);

  // Select the running profile that can take the link, or else the first one
  // that can, once the list and its states are known; again only when the
  // selected profile goes away.
  useEffect(() => {
    if (!isOpen || !browserState.isClient || profiles.length === 0) return;
    if (
      picked.current &&
      profiles.some((profile) => profile.id === selectedId)
    ) {
      return;
    }
    picked.current = true;
    const usable = profiles.filter((profile) =>
      browserState.canUseProfileForLinks(profile),
    );
    const pick =
      usable.find((profile) => runningProfiles.has(profile.id)) ??
      usable[0] ??
      profiles[0];
    setSelectedId(pick.id);
  }, [isOpen, browserState, profiles, runningProfiles, selectedId]);

  // The rows rise in once, as the dialog opens; rows that a search brings
  // back appear in place.
  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => setEntered(true), 600);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  // The chosen row may sit below the fold of a long list. Without a search
  // field the list holds the focus, so it names the chosen row itself.
  useEffect(() => {
    const list = listRef.current;
    const item = selectedId
      ? list?.querySelector('[cmdk-item][data-selected="true"]')
      : null;
    item?.scrollIntoView({ block: "nearest" });
    if (list && !searching) {
      if (item?.id) list.setAttribute("aria-activedescendant", item.id);
      else list.removeAttribute("aria-activedescendant");
    }
  }, [selectedId, searching]);

  const open = useCallback(
    async (profileId: string) => {
      const profile = profiles.find((p) => p.id === profileId);
      if (!url || !profile || launchingId !== null) return;
      if (!browserState.canUseProfileForLinks(profile)) return;
      setLaunchingId(profile.id);
      try {
        await invoke("open_url_with_profile", {
          profileId: profile.id,
          url,
          consentToken: null,
        });
        onClose();
      } catch (error) {
        console.error("Failed to open URL with profile:", error);
        // This path reaches the browser without going through page.tsx's gate,
        // so a launch the gate blocks surfaces here. Without a toast the deep
        // link would simply appear to do nothing.
        showErrorToast(translateBackendError(t, error));
      } finally {
        setLaunchingId(null);
      }
    },
    [profiles, url, launchingId, browserState, onClose, t],
  );

  const routeOf = (profile: BrowserProfile) => {
    if (profile.vpn_id) {
      const vpn = vpnConfigs.find((v) => v.id === profile.vpn_id);
      return vpn ? { vpn: true, name: vpn.name } : null;
    }
    const proxy = storedProxies.find((p) => p.id === profile.proxy_id);
    return proxy ? { vpn: false, name: proxy.name } : null;
  };
  const groupOf = (profile: BrowserProfile) =>
    groups.find((group) => group.id === profile.group_id)?.name;

  const link = url ? splitUrl(url) : null;
  const busy = launchingId !== null;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-3rem)] max-w-md flex-col gap-4 overflow-hidden rounded-2xl border-0 p-5 shadow-2xl ring-1 ring-foreground/10"
        dismissible={!busy}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (searchRef.current ?? listRef.current)?.focus();
        }}
      >
        <DialogHeader className="shrink-0 space-y-0">
          <DialogTitle className="text-base">
            {t("profileSelector.openLink")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("profileSelector.description")}
          </DialogDescription>
        </DialogHeader>

        {link && url && (
          <div
            data-slot="profile-selector-link"
            className="flex shrink-0 items-center gap-2.5 rounded-xl bg-foreground/4 p-2"
          >
            <ProfileGlyph
              seed={selected?.name ?? ""}
              routed={!!selected && !!routeOf(selected)}
              locked={!!selected?.password_protected}
              ephemeral={!!selected?.ephemeral}
              busy={busy}
              className="size-10"
            />
            <motion.span
              aria-hidden="true"
              className="shrink-0 text-muted-foreground [&_svg]:size-3.5"
              animate={busy && motionAllowed ? { x: [0, 3, 0] } : { x: 0 }}
              transition={
                busy && motionAllowed
                  ? { duration: 0.8, repeat: Infinity, ease: "easeInOut" }
                  : MOTION_SPRING.snappy
              }
            >
              <LuArrowRight />
            </motion.span>
            <div className="min-w-0 flex-1" title={url}>
              <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <LuGlobe
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="truncate">{link.host}</span>
              </p>
              {link.rest && (
                <p className="truncate pl-5 font-mono text-xs text-muted-foreground">
                  {link.rest}
                </p>
              )}
            </div>
            <CopyToClipboard
              text={url}
              variant="subtle"
              className="size-8 shrink-0 rounded-lg text-muted-foreground"
              successMessage={t("profileSelector.urlCopied")}
            />
          </div>
        )}

        {profiles.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-6 text-center">
            <ProfileGlyph
              seed=""
              routed={false}
              locked={false}
              ephemeral={false}
            />
            <p className="text-sm font-medium">
              {t("profileSelector.noneAvailableShort")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("profileSelector.noneAvailableLong")}
            </p>
          </div>
        ) : (
          <Command
            label={t("profileSelector.title")}
            value={selectedId}
            onValueChange={setSelectedId}
            disablePointerSelection
            loop
            filter={(_value, query, keywords = []) =>
              paletteScore(keywords[0] ?? "", keywords.slice(1), query)
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void open(selectedId);
              }
            }}
            className="min-h-0 bg-transparent **:data-[slot=command-input-wrapper]:mb-2 **:data-[slot=command-input-wrapper]:h-8 **:data-[slot=command-input-wrapper]:rounded-lg **:data-[slot=command-input-wrapper]:border-0 **:data-[slot=command-input-wrapper]:bg-foreground/5 **:data-[slot=command-input-wrapper]:px-2.5 **:data-[slot=command-input-wrapper]:transition-[background-color,box-shadow] **:data-[slot=command-input-wrapper]:focus-within:bg-foreground/6 **:data-[slot=command-input-wrapper]:focus-within:ring-2 **:data-[slot=command-input-wrapper]:focus-within:ring-foreground/10 [&_[data-slot=command-input-wrapper]_svg]:size-3.5"
          >
            {searching ? (
              <CommandInput
                ref={searchRef}
                value={search}
                onValueChange={setSearch}
                placeholder={t("profileSelector.searchPlaceholder")}
                disabled={busy}
                className="h-8 py-0"
              />
            ) : null}
            <CommandList
              ref={listRef}
              data-slot="profile-selector-list"
              className="-mx-1 max-h-72 px-1"
              // Without a search field, the list takes the keys.
              tabIndex={searching ? undefined : 0}
            >
              <div className="relative">
                <CommandGlide className="rounded-lg" />
                <CommandEmpty>
                  <span className="flex flex-col items-center gap-1.5 text-muted-foreground">
                    <LuSearchX className="size-5" aria-hidden="true" />
                    {t("profileSelector.noResults")}
                  </span>
                </CommandEmpty>
                {/* cmdk orders the matches of a search inside a group. */}
                <CommandGroup className="p-0">
                  {profiles.map((profile, index) => {
                    const running = runningProfiles.has(profile.id);
                    const usable = browserState.canUseProfileForLinks(profile);
                    const reason = usable
                      ? null
                      : browserState.getProfileTooltipContent(profile);
                    const route = routeOf(profile);
                    const group = groupOf(profile);
                    const os = profile.wayfern_config?.os ?? profile.host_os;
                    const OsIcon = os ? getOSIcon(os) : null;
                    return (
                      <CommandItem
                        key={profile.id}
                        value={profile.id}
                        keywords={[
                          profile.name,
                          route?.name ?? "",
                          group ?? "",
                        ]}
                        disabled={!usable || busy}
                        data-slot="profile-selector-option"
                        data-running={running || undefined}
                        onDoubleClick={() => void open(profile.id)}
                        className={ROW_CLASS}
                      >
                        <motion.span
                          className="flex min-w-0 flex-1 items-center gap-3"
                          initial={
                            motionAllowed && !entered && index < STAGGERED_ROWS
                              ? { y: 6 }
                              : false
                          }
                          animate={{ y: 0 }}
                          transition={{
                            ...MOTION_SPRING.page,
                            delay: index * 0.03,
                          }}
                        >
                          <ProfileGlyph
                            seed={profile.name}
                            routed={false}
                            locked={false}
                            ephemeral={false}
                            busy={launchingId === profile.id}
                            className="size-8"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-sm font-medium">
                                {profile.name}
                              </span>
                              {profile.password_protected && (
                                <LuLock
                                  className={META_ICON}
                                  aria-hidden="true"
                                />
                              )}
                              {profile.ephemeral && (
                                <LuFlame
                                  className={META_ICON}
                                  aria-hidden="true"
                                />
                              )}
                            </span>
                            {reason ? (
                              <span className="block truncate text-xs text-warning-text">
                                {reason}
                              </span>
                            ) : (
                              <span className="flex min-w-0 items-center gap-2.5 text-xs text-muted-foreground">
                                {os && OsIcon && (
                                  <span className="flex shrink-0 items-center gap-1">
                                    <OsIcon
                                      className={META_ICON}
                                      aria-hidden="true"
                                    />
                                    {getOSDisplayName(os)}
                                  </span>
                                )}
                                {route && (
                                  <span className="flex min-w-0 items-center gap-1">
                                    {route.vpn ? (
                                      <LuShieldCheck
                                        className={META_ICON}
                                        aria-hidden="true"
                                      />
                                    ) : (
                                      <LuGlobe
                                        className={META_ICON}
                                        aria-hidden="true"
                                      />
                                    )}
                                    <span className="truncate">
                                      {route.name}
                                    </span>
                                  </span>
                                )}
                                {group && (
                                  <span className="flex min-w-0 items-center gap-1">
                                    <LuFolder
                                      className={META_ICON}
                                      aria-hidden="true"
                                    />
                                    <span className="truncate">{group}</span>
                                  </span>
                                )}
                              </span>
                            )}
                          </span>
                          {running && (
                            <span className="flex shrink-0 items-center gap-1.5 text-xs text-success-text">
                              <StatusLight tone="success" live />
                              {t("profileSelector.badgeRunning")}
                            </span>
                          )}
                        </motion.span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </div>
            </CommandList>
          </Command>
        )}

        <DialogFooter className="shrink-0">
          <Button variant="subtle" onClick={onClose} disabled={busy}>
            {t("common.buttons.cancel")}
          </Button>
          <LoadingButton
            data-slot="profile-selector-open"
            isLoading={busy}
            onClick={() => void open(selectedId)}
            disabled={!canOpen}
            className="h-9 rounded-md px-4"
          >
            {t("profileSelector.openButton")}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
