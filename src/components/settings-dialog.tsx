"use client";

import { invoke } from "@tauri-apps/api/core";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { motion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  LuArrowUpRight,
  LuBell,
  LuBriefcaseBusiness,
  LuCamera,
  LuCopy,
  LuEyeOff,
  LuGlobe,
  LuLogIn,
  LuMic,
  LuMonitor,
  LuMonitorCog,
  LuNetwork,
  LuPalette,
  LuRocket,
  LuRotateCcw,
  LuSearch,
  LuTrash2,
  LuVolume2,
  LuWrench,
  LuX,
} from "react-icons/lu";
import { DnsBlocklistDialog } from "@/components/dns-blocklist-dialog";
import { LoadingButton } from "@/components/loading-button";
import { LogViewer } from "@/components/log-viewer";
import { AppProxySettings } from "@/components/settings/app-proxy-settings";
import { EncryptionSettings } from "@/components/settings/encryption-settings";
import {
  ChoiceCard,
  ChoiceGroup,
  RowIcon,
  SegmentedControl,
  SettingBlock,
  SettingRow,
  SettingSlider,
  SettingsCard,
  SettingsSection,
} from "@/components/settings/settings-primitives";
import {
  SoundSettings,
  soundDraft,
} from "@/components/settings/sound-settings";
import {
  ThemeColorEditor,
  ThemeModePicker,
  ThemePresetGallery,
} from "@/components/settings/theme-settings";
import { useAutosavedSettings } from "@/components/settings/use-autosaved-settings";
import { useTheme } from "@/components/theme-provider";
import { AnimatedDisclosureContent } from "@/components/ui/animated-disclosure";
import { AnimatedSwitch } from "@/components/ui/animated-switch";
import { Button } from "@/components/ui/button";
import { CopyToClipboard } from "@/components/ui/copy-to-clipboard";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Input } from "@/components/ui/input";
import { ScrollStrip } from "@/components/ui/scroll-strip";
import { StatusLight } from "@/components/ui/settings-panel";
import { useCloudAuth } from "@/hooks/use-cloud-auth";
import { useCommercialTrial } from "@/hooks/use-commercial-trial";
import { useInterfaceZoom } from "@/hooks/use-interface-zoom";
import { useLanguage } from "@/hooks/use-language";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import type { PermissionType } from "@/hooks/use-permissions";
import { usePermissions } from "@/hooks/use-permissions";
import type { SupportedLanguage } from "@/i18n";
import { translateBackendError } from "@/lib/backend-errors";
import { effectivePlanOf } from "@/lib/entitlements";
import { INTERFACE_ZOOM_STEPS } from "@/lib/interface-zoom";
import {
  MOTION_DURATION,
  MOTION_EASE_OUT,
  MOTION_SPRING_POSITION,
} from "@/lib/motion";
import { planLabel } from "@/lib/plan-labels";
import {
  applyThemeColors,
  clearThemeColors,
  getThemeByColors,
  getThemeById,
  withThemeTransition,
} from "@/lib/themes";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { SetDefaultBrowserOutcome } from "@/types";

/** The retention choices offered, in days. 0 turns the trash off. */
const TRASH_RETENTION_DAYS = [0, 1, 7, 14, 30, 90] as const;
const DEFAULT_TRASH_RETENTION_DAYS = 30;
/** The commercial trial length, to draw how much of it is left. */
const TRIAL_DAYS = 14;
/** Saved defaults of the bulk launch pacing; the backend clamps the same way. */
const DEFAULT_BULK_LAUNCH_DELAY_MS = 800;
const DEFAULT_BULK_LAUNCH_CONCURRENCY = 3;
/** Pause choices in ms: fine under two seconds, coarse up to a minute. */
const BULK_LAUNCH_DELAY_STOPS = [
  0, 200, 400, 600, 800, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000, 15000,
  20000, 30000, 45000, 60000,
] as const;
const BULK_LAUNCH_CONCURRENCY_STOPS = Array.from(
  { length: 20 },
  (_, index) => index + 1,
);

const PERMISSION_TYPES: PermissionType[] = ["microphone", "camera"];

/** Each section's nav id, title, icon and the translation keys search reads. */
const SECTIONS: Array<{
  id: string;
  title: string;
  icon: ReactNode;
  search: string[];
}> = [
  {
    id: "appearance",
    title: "settings.appearance.title",
    icon: <LuPalette />,
    search: ["settings.appearance", "settings.language"],
  },
  {
    id: "sounds",
    title: "settings.sounds.title",
    icon: <LuVolume2 />,
    search: ["settings.sounds"],
  },
  {
    id: "system",
    title: "settings.system.title",
    icon: <LuMonitorCog />,
    search: [
      "settings.system",
      "settings.defaultBrowser",
      "settings.permissions",
      "settings.commercial",
    ],
  },
  {
    id: "launches",
    title: "settings.launches.title",
    icon: <LuRocket />,
    search: [
      "settings.launches",
      "settings.privacy.requireRoute",
      "settings.privacy.requireRouteDescription",
      "settings.privacy.askRoute",
      "settings.privacy.askRouteDescription",
      "settings.privacy.consistencyWarning",
      "settings.privacy.consistencyWarningDescription",
      "settings.privacy.vpnExtensionWarning",
      "settings.privacy.vpnExtensionWarningDescription",
    ],
  },
  {
    id: "network",
    title: "settings.network.title",
    icon: <LuNetwork />,
    search: [
      "settings.network",
      "settings.dns",
      "dnsBlocklist.title",
      "dnsBlocklist.settingsDescription",
      "settings.integrations",
    ],
  },
  {
    id: "privacy",
    title: "settings.privacy.title",
    icon: <LuEyeOff />,
    search: [
      "settings.privacy.title",
      "settings.privacy.recordSites",
      "settings.privacy.recordSitesDescription",
      "settings.privacy.clearTraffic",
      "settings.privacy.clearTrafficDescription",
      "settings.trashRetention",
      "settings.trashRetentionDescription",
      "settings.encryption",
    ],
  },
  {
    id: "advanced",
    title: "settings.advanced.title",
    icon: <LuWrench />,
    search: [
      "settings.advanced",
      "settings.disableAutoUpdates",
      "settings.disableAutoUpdatesDescription",
      "settings.keepDecryptedProfilesInRam",
      "settings.keepDecryptedProfilesInRamDescription",
      "logViewer.title",
    ],
  },
];

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onIntegrationsOpen?: () => void;
  subPage?: boolean;
  /**
   * A section, or a setting inside one (`data-settings-target`), to scroll
   * to and focus as soon as the page opens.
   */
  initialSection?: string | null;
}

export function SettingsDialog({
  isOpen,
  onClose,
  onIntegrationsOpen,
  subPage,
  initialSection = null,
}: SettingsDialogProps) {
  const { settings, update, isLoading, loaded, saveState } =
    useAutosavedSettings(isOpen);
  const [isDefaultBrowser, setIsDefaultBrowser] = useState(false);
  const [search, setSearch] = useState("");
  const [jumpTo, setJumpTo] = useState<string | null>(initialSection);
  const sectionsRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // The section the reader is in, so the nav can point at it. A click pins
  // its target until the reader scrolls away, because the last sections can
  // never reach the top of the scroller on their own.
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const pinnedSectionRef = useRef<{ id: string; scrollTop: number } | null>(
    null,
  );
  const animateNav = useMotionAllowed();
  const [isSettingDefault, setIsSettingDefault] = useState(false);
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [isClearingTraffic, setIsClearingTraffic] = useState(false);
  const [requestingPermission, setRequestingPermission] =
    useState<PermissionType | null>(null);
  const [dnsBlocklistDialogOpen, setDnsBlocklistDialogOpen] = useState(false);
  const [hasE2ePassword, setHasE2ePassword] = useState(false);
  const [systemInfo, setSystemInfo] = useState<{
    app_version: string;
    os: string;
    arch: string;
    portable: boolean;
  } | null>(null);

  const { t, i18n } = useTranslation();
  const interfaceZoom = useInterfaceZoom();
  const { setTheme } = useTheme();
  const {
    requestPermission,
    isMicrophoneAccessGranted,
    isCameraAccessGranted,
    currentOS,
  } = usePermissions(isOpen);
  const isMacOS = currentOS === "macos";
  const isLinux = currentOS === "linux";
  const { trialStatus } = useCommercialTrial();
  const { user: cloudUser } = useCloudAuth();
  // Encryption is available to everyone except team members who aren't owners
  const canUseEncryption =
    cloudUser == null ||
    effectivePlanOf(cloudUser) !== "team" ||
    cloudUser.teamRole === "owner";
  const {
    currentLanguage,
    changeLanguage,
    supportedLanguages,
    isLoading: isLanguageLoading,
  } = useLanguage();
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    void invoke<boolean>("check_has_e2e_password")
      .then(setHasE2ePassword)
      .catch(() => {
        setHasE2ePassword(false);
      });
    void invoke<{
      app_version: string;
      os: string;
      arch: string;
      portable: boolean;
    }>("get_system_info")
      .then(setSystemInfo)
      .catch(() => {
        setSystemInfo(null);
      });
  }, [isOpen]);

  // The Linux implementation shells out to `which` plus two `xdg-mime query`
  // calls, and `xdg-mime` is a shell script that forks further. Without this
  // guard a slow desktop lets the poll below stack one unfinished call on top
  // of another every few seconds, and each one occupies a worker of the same
  // runtime every other Tauri command shares.
  const defaultBrowserCheckInFlight = useRef(false);
  const checkDefaultBrowserStatus = useCallback(async () => {
    if (defaultBrowserCheckInFlight.current) {
      return;
    }
    defaultBrowserCheckInFlight.current = true;
    try {
      const isDefault = await invoke<boolean>("is_default_browser");
      setIsDefaultBrowser(isDefault);
    } catch (error) {
      console.error("Failed to check default browser status:", error);
    } finally {
      defaultBrowserCheckInFlight.current = false;
    }
  }, []);

  const handleSetDefaultBrowser = useCallback(async () => {
    setIsSettingDefault(true);
    try {
      // Windows keeps the final choice for its own settings page, so a call
      // that succeeded does not always mean Donut is the default yet. Say which
      // of the two happened.
      const outcome = await invoke<SetDefaultBrowserOutcome>(
        "set_as_default_browser",
      );
      await checkDefaultBrowserStatus();

      if (outcome.status === "awaitingSystemSettings") {
        showSuccessToast(t("settings.defaultBrowser.finishInSystemSettings"), {
          description: t(
            "settings.defaultBrowser.finishInSystemSettingsDescription",
          ),
          duration: 8000,
        });
      } else {
        showSuccessToast(t("settings.defaultBrowser.setSuccess"));
      }
    } catch (error) {
      showErrorToast(t("settings.defaultBrowser.setFailed"), {
        description: translateBackendError(t, error),
        duration: 8000,
      });
    } finally {
      setIsSettingDefault(false);
    }
  }, [checkDefaultBrowserStatus, t]);

  const handleClearTraffic = useCallback(async () => {
    setIsClearingTraffic(true);
    try {
      await invoke("clear_all_traffic_stats");
      showSuccessToast(t("settings.privacy.clearTrafficSuccess"));
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setIsClearingTraffic(false);
    }
  }, [t]);

  const handleClearCache = useCallback(async () => {
    setIsClearingCache(true);
    try {
      await invoke("clear_all_version_cache_and_refetch");
      await invoke("clear_all_traffic_stats");
      // The version update progress events report the result.
    } catch (error) {
      console.error("Failed to clear cache:", error);
      showErrorToast(t("settings.advanced.clearCacheFailed"), {
        description: translateBackendError(t, error),
        duration: 4000,
      });
    } finally {
      setIsClearingCache(false);
    }
  }, [t]);

  const handleRequestPermission = useCallback(
    async (permissionType: PermissionType) => {
      setRequestingPermission(permissionType);
      try {
        const granted = await requestPermission(permissionType);
        if (granted) {
          showSuccessToast(
            permissionType === "microphone"
              ? t("permissionDialog.grantedToastMicrophone")
              : t("permissionDialog.grantedToastCamera"),
          );
          return;
        }

        await openUrl(
          `x-apple.systempreferences:com.apple.preference.security?${
            permissionType === "microphone"
              ? "Privacy_Microphone"
              : "Privacy_Camera"
          }`,
        );
        showErrorToast(
          permissionType === "microphone"
            ? t("permissionDialog.stillNotGrantedMicrophone")
            : t("permissionDialog.stillNotGrantedCamera"),
        );
      } catch (error) {
        console.error("Failed to request permission:", error);
        showErrorToast(t("permissionDialog.requestFailed"));
      } finally {
        setRequestingPermission(null);
      }
    },
    [requestPermission, t],
  );

  // The theme on screen follows the settings: a pick, a color edit, and a
  // failed save putting the stored theme back. Only a change of theme is
  // animated; the first run re-applies the palette already on screen.
  const appliedThemeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const previous = appliedThemeRef.current;
    appliedThemeRef.current = settings.theme;
    const animate = previous !== null && previous !== settings.theme;
    if (settings.theme === "custom") {
      const colors = settings.custom_theme ?? {};
      const apply = () => {
        applyThemeColors(colors);
      };
      if (animate) withThemeTransition(apply);
      else apply();
      setTheme("custom", { animate: false });
    } else {
      clearThemeColors();
      setTheme(settings.theme, { animate });
    }
  }, [loaded, settings.theme, settings.custom_theme, setTheme]);

  useEffect(() => {
    if (isOpen) {
      checkDefaultBrowserStatus().catch((err: unknown) => {
        console.error(err);
      });

      // Re-check periodically so the badge follows a change the user made in
      // their desktop settings. Ten seconds: on Linux each check is three
      // subprocesses.
      const intervalId = setInterval(() => {
        checkDefaultBrowserStatus().catch((err: unknown) => {
          console.error(err);
        });
      }, 10000);

      return () => {
        clearInterval(intervalId);
      };
    }
  }, [isOpen, checkDefaultBrowserStatus]);

  useEffect(() => {
    if (isOpen && !isLanguageLoading) {
      setSelectedLanguage(currentLanguage);
    }
  }, [isOpen, currentLanguage, isLanguageLoading]);

  const pickLanguage = (value: string) => {
    const previous = selectedLanguage;
    setSelectedLanguage(value);
    changeLanguage(
      value === "system" ? null : (value as SupportedLanguage),
    ).catch((error: unknown) => {
      setSelectedLanguage(previous);
      showErrorToast(t("appFeedback.saveFailed"), {
        description: translateBackendError(t, error),
      });
    });
  };

  const sounds = soundDraft(settings);

  const sections = SECTIONS;
  const needle = search.trim().toLocaleLowerCase();
  const matchingSections = sections.filter(({ title, search: keys }) => {
    const text = [title, ...keys]
      .map((key) => JSON.stringify(t(key, { returnObjects: true })))
      .join(" ")
      .toLocaleLowerCase();
    return needle.split(/\s+/).every((word) => text.includes(word));
  });
  const sectionVisible = (id: string) =>
    matchingSections.some((section) => section.id === id);
  const visibleSectionIds = matchingSections.map(({ id }) => id).join(",");
  const sectionProps = (id: string) => {
    const section = SECTIONS.find((entry) => entry.id === id);
    return {
      id,
      icon: section?.icon,
      title: t(section?.title ?? id),
      active: activeSection === id,
      hidden: !sectionVisible(id),
    };
  };

  const syncActiveSection = useCallback(() => {
    const scroller = scrollerRef.current;
    const root = sectionsRef.current;
    if (!scroller || !root) return;
    const nodes = [
      ...root.querySelectorAll<HTMLElement>("[data-settings-section]"),
    ].filter((node) => !node.hidden);
    if (nodes.length === 0) {
      setActiveSection(null);
      return;
    }
    const pinned = pinnedSectionRef.current;
    if (pinned && Math.abs(scroller.scrollTop - pinned.scrollTop) < 4) {
      setActiveSection(pinned.id);
      return;
    }
    pinnedSectionRef.current = null;
    const atBottom =
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (atBottom) {
      setActiveSection(nodes[nodes.length - 1].dataset.settingsSection ?? null);
      return;
    }
    const threshold = scroller.getBoundingClientRect().top + 12;
    let current = nodes[0];
    for (const node of nodes) {
      if (node.getBoundingClientRect().top <= threshold) current = node;
      else break;
    }
    setActiveSection(current.dataset.settingsSection ?? null);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the section list changes with the search filter and the settings load, and the sync must run again then
  useEffect(() => {
    syncActiveSection();
  }, [syncActiveSection, visibleSectionIds, isLoading]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a target row (the default browser, permissions) can appear only after the settings and system facts load
  useEffect(() => {
    // The page is inert while it loads, and an inert row cannot take focus.
    if (!jumpTo || isLoading) return;
    const target = sectionsRef.current?.querySelector<HTMLElement>(
      `[data-settings-section="${jumpTo}"], [data-settings-target="${jumpTo}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
    const section =
      target.closest<HTMLElement>("[data-settings-section]")?.dataset
        .settingsSection ?? jumpTo;
    if (scrollerRef.current) {
      pinnedSectionRef.current = {
        id: section,
        scrollTop: scrollerRef.current.scrollTop,
      };
    }
    setActiveSection(section);
    setJumpTo(null);
  }, [jumpTo, isLoading, systemInfo, isMacOS]);

  const jump = (id: string) => {
    setSearch("");
    setJumpTo(id);
  };

  const pickTheme = (value: string) => {
    update({ theme: value });
  };
  const customColors = settings.custom_theme ?? {};
  const selectedPresetId = getThemeByColors(customColors)?.id ?? null;

  const plan = cloudUser ? effectivePlanOf(cloudUser) : "free";
  const systemLine = systemInfo
    ? `Donut Browser ${systemInfo.app_version} · ${systemInfo.os} ${systemInfo.arch}${systemInfo.portable ? " (portable)" : ""}`
    : "";

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose} subPage={subPage}>
        <DialogContent className="flex max-h-[calc(100vh-5rem)] max-w-3xl flex-col">
          {!subPage && (
            <DialogHeader className="shrink-0">
              <DialogTitle>{t("settings.title")}</DialogTitle>
            </DialogHeader>
          )}

          <div className="mx-auto flex w-full max-w-4xl shrink-0 flex-col gap-2 pb-2">
            <div className="relative">
              <LuSearch
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={searchRef}
                data-slot="settings-search"
                variant="soft"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  // Escape empties the filter before it can close the page.
                  if (event.key === "Escape" && search) {
                    event.preventDefault();
                    event.stopPropagation();
                    setSearch("");
                  }
                }}
                placeholder={t("appFeedback.searchSettings")}
                aria-label={t("appFeedback.searchSettings")}
                className="h-8 pr-8 pl-8 text-sm md:text-sm"
              />
              {search && (
                <button
                  type="button"
                  aria-label={t("common.buttons.clear")}
                  onClick={() => {
                    setSearch("");
                    searchRef.current?.focus();
                  }}
                  className={cn(
                    "absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
                    FOCUS_RING,
                  )}
                >
                  <LuX className="size-3" />
                </button>
              )}
            </div>
            <nav aria-label={t("settings.title")}>
              <ScrollStrip
                data-slot="settings-nav"
                activeKey={activeSection}
                scrollLeftLabel={t("settings.scrollSectionsLeft")}
                scrollRightLabel={t("settings.scrollSectionsRight")}
                stripClassName="gap-1"
              >
                {sections.map(({ id, title }) => {
                  const active = activeSection === id;
                  const dimmed = needle !== "" && !sectionVisible(id);
                  return (
                    <button
                      type="button"
                      key={id}
                      data-slot="settings-nav-item"
                      data-section={id}
                      aria-current={active ? "location" : undefined}
                      onClick={() => jump(id)}
                      className={cn(
                        "relative isolate shrink-0 rounded-md px-2 py-1 text-xs whitespace-nowrap transition-[color,background-color,opacity] duration-150 focus-visible:outline-2 focus-visible:outline-ring",
                        active
                          ? "text-foreground"
                          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                        dimmed && "opacity-40",
                      )}
                    >
                      {active && (
                        <motion.span
                          aria-hidden="true"
                          data-slot="settings-nav-indicator"
                          layoutId={
                            animateNav ? "settings-nav-indicator" : undefined
                          }
                          initial={false}
                          transition={
                            animateNav
                              ? MOTION_SPRING_POSITION
                              : { duration: 0 }
                          }
                          className="absolute inset-0 -z-10 rounded-md bg-foreground/8"
                        />
                      )}
                      {t(title)}
                    </button>
                  );
                })}
              </ScrollStrip>
            </nav>
          </div>

          {/* The scroller spans the full width (so the wheel works over the
              side gutters); the width cap lives on the inner column. */}
          <div
            ref={scrollerRef}
            data-slot="settings-scroller"
            data-save-state={saveState}
            onScroll={syncActiveSection}
            className={cn(
              "min-h-0 flex-1 overflow-y-auto",
              subPage ? "py-2" : "py-4",
            )}
          >
            {/* Not a fieldset: Chrome lays a grid fieldset's container-query
                children out at zero height until something forces a reflow. */}
            <div
              ref={sectionsRef}
              inert={isLoading}
              className="mx-auto grid w-full max-w-4xl min-w-0 gap-8 pb-6"
            >
              <SettingsSection {...sectionProps("appearance")}>
                <SettingsCard>
                  <SettingBlock
                    label={t("settings.appearance.theme")}
                    description={t("settings.appearance.themeDescription")}
                  >
                    <ThemeModePicker
                      value={settings.theme}
                      onValueChange={pickTheme}
                      customColors={customColors}
                    />
                  </SettingBlock>
                  <AnimatedDisclosureContent
                    open={settings.theme === "custom"}
                    className="divide-y divide-foreground/8"
                  >
                    <SettingBlock label={t("settings.appearance.themePreset")}>
                      <ThemePresetGallery
                        selectedId={selectedPresetId}
                        colors={customColors}
                        onSelect={(id) => {
                          const theme = id ? getThemeById(id) : undefined;
                          if (theme) update({ custom_theme: theme.colors });
                        }}
                      />
                    </SettingBlock>
                    <SettingBlock label={t("settings.appearance.customColors")}>
                      <ThemeColorEditor
                        colors={customColors}
                        onChange={({ colors }) => {
                          update({ custom_theme: colors });
                        }}
                      />
                    </SettingBlock>
                  </AnimatedDisclosureContent>
                  <SettingBlock label={t("settings.appearance.interfaceSize")}>
                    <ChoiceGroup
                      value={String(interfaceZoom.zoom)}
                      onValueChange={(value) => {
                        void interfaceZoom
                          .setZoom(Number(value))
                          .catch((error: unknown) => {
                            showErrorToast(translateBackendError(t, error));
                          });
                      }}
                      label={t("settings.appearance.interfaceSize")}
                      slot="settings-interface-size"
                      className="flex flex-wrap gap-1.5"
                    >
                      {INTERFACE_ZOOM_STEPS.map((step) => (
                        <ChoiceCard
                          key={step}
                          value={String(step)}
                          slot="settings-interface-size-option"
                          className="px-3 py-1.5 text-sm font-medium tabular-nums hover:bg-foreground/5"
                        >
                          {new Intl.NumberFormat(i18n.language, {
                            style: "percent",
                          }).format(step / 100)}
                        </ChoiceCard>
                      ))}
                    </ChoiceGroup>
                  </SettingBlock>
                  <SettingBlock
                    target="language"
                    label={t("settings.language.interface")}
                    description={t("settings.language.description")}
                  >
                    <ChoiceGroup
                      value={selectedLanguage ?? "system"}
                      onValueChange={pickLanguage}
                      label={t("settings.language.interface")}
                      slot="settings-language"
                      className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-1.5"
                    >
                      <ChoiceCard
                        value="system"
                        slot="settings-language-option"
                        className="flex items-center gap-2 px-3 py-2 hover:bg-foreground/5"
                      >
                        <LuMonitor className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="text-sm leading-tight font-medium">
                          {t("settings.language.systemDefault")}
                        </span>
                      </ChoiceCard>
                      {supportedLanguages.map((lang) => (
                        <ChoiceCard
                          key={lang.code}
                          value={lang.code}
                          slot="settings-language-option"
                          className="flex flex-col px-3 py-2 hover:bg-foreground/5"
                        >
                          <span
                            lang={lang.code}
                            className="truncate text-sm font-medium"
                          >
                            {lang.nativeName}
                          </span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {lang.name}
                          </span>
                        </ChoiceCard>
                      ))}
                    </ChoiceGroup>
                  </SettingBlock>
                </SettingsCard>
              </SettingsSection>

              <SettingsSection {...sectionProps("sounds")}>
                <SettingsCard>
                  <SoundSettings draft={sounds} onChange={update} />
                </SettingsCard>
              </SettingsSection>

              <SettingsSection {...sectionProps("system")}>
                <SettingsCard>
                  {!systemInfo?.portable && (
                    <SettingRow
                      slot="settings-default-browser"
                      target="default"
                      label={
                        isDefaultBrowser
                          ? t("settings.defaultBrowser.isDefault")
                          : t("settings.defaultBrowser.notDefault")
                      }
                      description={t("settings.defaultBrowser.description")}
                      icon={
                        <RowIcon tone={isDefaultBrowser ? "success" : "muted"}>
                          <LuGlobe />
                        </RowIcon>
                      }
                    >
                      {isDefaultBrowser ? (
                        <StatusChip tone="success">
                          {t("common.status.active")}
                        </StatusChip>
                      ) : (
                        <LoadingButton
                          size="sm"
                          variant="soft"
                          className="h-8"
                          isLoading={isSettingDefault}
                          onClick={() => {
                            void handleSetDefaultBrowser();
                          }}
                        >
                          {t("settings.defaultBrowser.setAsDefault")}
                        </LoadingButton>
                      )}
                    </SettingRow>
                  )}
                  <SwitchRow
                    id="settings-launch-at-login"
                    label={t("settings.system.launchAtLogin")}
                    description={t("settings.system.launchAtLoginDescription")}
                    checked={settings.launch_at_login ?? false}
                    onCheckedChange={(v) => update({ launch_at_login: v })}
                    icon={
                      <RowIcon
                        tone={settings.launch_at_login ? "primary" : "muted"}
                      >
                        <LuLogIn />
                      </RowIcon>
                    }
                  />
                  <SwitchRow
                    id="settings-reopen-running"
                    label={t("settings.system.reopenRunning")}
                    description={t("settings.system.reopenRunningDescription")}
                    checked={settings.reopen_running_profiles ?? false}
                    onCheckedChange={(v) =>
                      update({ reopen_running_profiles: v })
                    }
                    icon={
                      <RowIcon
                        tone={
                          settings.reopen_running_profiles ? "primary" : "muted"
                        }
                      >
                        <LuRotateCcw />
                      </RowIcon>
                    }
                  />
                  <SwitchRow
                    id="settings-system-notifications"
                    label={t("settings.system.notifications")}
                    description={t("settings.system.notificationsDescription")}
                    checked={settings.system_notifications ?? true}
                    onCheckedChange={(v) => update({ system_notifications: v })}
                    icon={
                      <RowIcon
                        tone={
                          (settings.system_notifications ?? true)
                            ? "primary"
                            : "muted"
                        }
                      >
                        <LuBell />
                      </RowIcon>
                    }
                  />
                  <CommercialRow plan={plan} trialStatus={trialStatus} />
                </SettingsCard>
                {isMacOS && (
                  <>
                    <SettingsCard>
                      {PERMISSION_TYPES.map((type) => {
                        const granted =
                          type === "microphone"
                            ? isMicrophoneAccessGranted
                            : isCameraAccessGranted;
                        return (
                          <SettingRow
                            key={type}
                            target={
                              type === "microphone" ? "permissions" : undefined
                            }
                            label={t(`settings.permissions.${type}`)}
                            description={t(
                              `settings.permissions.${type}Description`,
                            )}
                            icon={
                              <RowIcon tone={granted ? "success" : "muted"}>
                                {type === "microphone" ? (
                                  <LuMic />
                                ) : (
                                  <LuCamera />
                                )}
                              </RowIcon>
                            }
                          >
                            {granted ? (
                              <StatusChip tone="success">
                                {t("common.status.granted")}
                              </StatusChip>
                            ) : (
                              <LoadingButton
                                size="sm"
                                variant="soft"
                                className="h-8"
                                isLoading={requestingPermission === type}
                                onClick={() => {
                                  void handleRequestPermission(type);
                                }}
                              >
                                {t("common.buttons.grant")}
                              </LoadingButton>
                            )}
                          </SettingRow>
                        );
                      })}
                    </SettingsCard>
                    <SectionNote>
                      {t("settings.permissions.description")}
                    </SectionNote>
                  </>
                )}
              </SettingsSection>

              <SettingsSection {...sectionProps("launches")}>
                <SettingsCard>
                  <SettingRow
                    label={t("settings.launches.delay")}
                    description={t("settings.launches.delayDescription")}
                  >
                    <SettingSlider
                      slot="settings-bulk-launch-delay"
                      value={
                        settings.bulk_launch_delay_ms ??
                        DEFAULT_BULK_LAUNCH_DELAY_MS
                      }
                      stops={BULK_LAUNCH_DELAY_STOPS}
                      label={t("settings.launches.delay")}
                      format={(ms) =>
                        t("settings.launches.seconds", {
                          value: (ms / 1000).toLocaleString(i18n.language, {
                            maximumFractionDigits: 1,
                          }),
                        })
                      }
                      onChange={(ms) => update({ bulk_launch_delay_ms: ms })}
                    />
                  </SettingRow>
                  <SettingRow
                    label={t("settings.launches.concurrency")}
                    description={t("settings.launches.concurrencyDescription")}
                  >
                    <SettingSlider
                      slot="settings-bulk-launch-concurrency"
                      value={
                        settings.bulk_launch_concurrency ??
                        DEFAULT_BULK_LAUNCH_CONCURRENCY
                      }
                      stops={BULK_LAUNCH_CONCURRENCY_STOPS}
                      label={t("settings.launches.concurrency")}
                      format={(count) => String(count)}
                      onChange={(count) =>
                        update({ bulk_launch_concurrency: count })
                      }
                    />
                  </SettingRow>
                  <SwitchRow
                    id="settings-require-route"
                    label={t("settings.privacy.requireRoute")}
                    description={t("settings.privacy.requireRouteDescription")}
                    checked={settings.require_route_for_launch ?? false}
                    onCheckedChange={(v) =>
                      update({ require_route_for_launch: v })
                    }
                  />
                  <AnimatedDisclosureContent
                    open={!(settings.require_route_for_launch ?? false)}
                  >
                    <SwitchRow
                      id="settings-ask-route"
                      label={t("settings.privacy.askRoute")}
                      description={t("settings.privacy.askRouteDescription")}
                      checked={settings.ask_route_for_launch ?? false}
                      onCheckedChange={(v) =>
                        update({ ask_route_for_launch: v })
                      }
                    />
                  </AnimatedDisclosureContent>
                  <SwitchRow
                    id="settings-consistency-warning"
                    label={t("settings.privacy.consistencyWarning")}
                    description={t(
                      "settings.privacy.consistencyWarningDescription",
                    )}
                    checked={!(settings.fingerprint_gate_disabled ?? false)}
                    onCheckedChange={(v) =>
                      update({ fingerprint_gate_disabled: !v })
                    }
                  />
                  <SwitchRow
                    id="settings-vpn-extension-warning"
                    label={t("settings.privacy.vpnExtensionWarning")}
                    description={t(
                      "settings.privacy.vpnExtensionWarningDescription",
                    )}
                    checked={
                      !(settings.vpn_extension_warning_disabled ?? false)
                    }
                    onCheckedChange={(v) =>
                      update({ vpn_extension_warning_disabled: !v })
                    }
                  />
                </SettingsCard>
              </SettingsSection>

              <SettingsSection {...sectionProps("network")}>
                <AppProxySettings />
                <SettingsCard>
                  <SettingRow
                    target="dns"
                    label={t("settings.dns.label")}
                    description={t("dnsBlocklist.settingsDescription")}
                  >
                    <Button
                      variant="soft"
                      size="sm"
                      onClick={() => setDnsBlocklistDialogOpen(true)}
                    >
                      {t("settings.manage")}
                    </Button>
                  </SettingRow>
                  <SettingRow
                    target="integrations"
                    label={t("settings.integrations.label")}
                    description={t("settings.integrations.description")}
                  >
                    <Button
                      variant="soft"
                      size="sm"
                      onClick={onIntegrationsOpen}
                    >
                      {t("settings.open")}
                      <LuArrowUpRight className="size-3.5" />
                    </Button>
                  </SettingRow>
                </SettingsCard>
              </SettingsSection>

              <SettingsSection {...sectionProps("privacy")}>
                <SettingsCard>
                  <SwitchRow
                    id="settings-record-sites"
                    label={t("settings.privacy.recordSites")}
                    description={t("settings.privacy.recordSitesDescription")}
                    checked={settings.record_traffic_domains ?? true}
                    onCheckedChange={(v) =>
                      update({ record_traffic_domains: v })
                    }
                  />
                  <SettingRow
                    htmlFor="trash-retention"
                    label={t("settings.trashRetention")}
                    description={t("settings.trashRetentionDescription")}
                  >
                    <SegmentedControl
                      id="trash-retention"
                      slot="settings-trash-retention"
                      label={t("settings.trashRetention")}
                      value={
                        settings.trash_retention_days ??
                        DEFAULT_TRASH_RETENTION_DAYS
                      }
                      onValueChange={(days) =>
                        update({ trash_retention_days: days })
                      }
                      options={TRASH_RETENTION_DAYS.map((days) => ({
                        value: days,
                        label:
                          days === 0
                            ? t("settings.trashRetentionOff")
                            : t("settings.trashRetentionDays", { count: days }),
                      }))}
                    />
                  </SettingRow>
                  <SettingRow
                    label={t("settings.privacy.clearTraffic")}
                    description={t("settings.privacy.clearTrafficDescription")}
                  >
                    <LoadingButton
                      size="sm"
                      variant="soft"
                      className="h-8 text-destructive-text hover:bg-destructive/10"
                      isLoading={isClearingTraffic}
                      onClick={() => {
                        void handleClearTraffic();
                      }}
                    >
                      <LuTrash2 className="size-3.5" />
                      {t("settings.clear")}
                    </LoadingButton>
                  </SettingRow>
                </SettingsCard>
                <div
                  data-settings-target="encryption"
                  tabIndex={-1}
                  className="scroll-mt-3 focus:outline-none"
                >
                  <EncryptionSettings
                    canUseEncryption={canUseEncryption}
                    hasPassword={hasE2ePassword}
                    onHasPasswordChange={setHasE2ePassword}
                  />
                </div>
              </SettingsSection>

              <SettingsSection {...sectionProps("advanced")}>
                <SettingsCard>
                  {!isLinux && (
                    <SwitchRow
                      id="disable-auto-updates"
                      label={t("settings.disableAutoUpdates")}
                      description={t("settings.disableAutoUpdatesDescription")}
                      checked={settings.disable_auto_updates ?? false}
                      onCheckedChange={(v) =>
                        update({ disable_auto_updates: v })
                      }
                    />
                  )}
                  <SwitchRow
                    id="keep-decrypted-profiles-in-ram"
                    label={t("settings.keepDecryptedProfilesInRam")}
                    description={t(
                      "settings.keepDecryptedProfilesInRamDescription",
                    )}
                    checked={settings.keep_decrypted_profiles_in_ram ?? false}
                    onCheckedChange={(v) =>
                      update({ keep_decrypted_profiles_in_ram: v })
                    }
                  />
                  <SettingRow
                    label={t("settings.advanced.clearCache")}
                    description={t("settings.advanced.clearCacheDescription")}
                  >
                    <LoadingButton
                      size="sm"
                      variant="soft"
                      className="h-8"
                      isLoading={isClearingCache}
                      onClick={() => {
                        void handleClearCache();
                      }}
                    >
                      {t("settings.clear")}
                    </LoadingButton>
                  </SettingRow>
                  <SettingRow
                    label={t("settings.advanced.logs")}
                    description={t("settings.advanced.copyLogsDescription")}
                  >
                    <Button
                      variant="soft"
                      size="sm"
                      onClick={async () => {
                        try {
                          const content =
                            await invoke<string>("read_log_files");
                          await writeClipboardText(content);
                          showSuccessToast(
                            t("settings.advanced.copyLogsSuccess"),
                          );
                        } catch (err) {
                          showErrorToast(translateBackendError(t, err));
                        }
                      }}
                    >
                      <LuCopy className="size-3.5" />
                      {t("settings.advanced.copyLogs")}
                    </Button>
                    <Button
                      variant="soft"
                      size="sm"
                      onClick={async () => {
                        try {
                          await invoke("open_log_directory");
                        } catch (err) {
                          showErrorToast(translateBackendError(t, err));
                        }
                      }}
                    >
                      {t("settings.advanced.openLogDir")}
                    </Button>
                  </SettingRow>
                  <SettingBlock label={t("logViewer.title")}>
                    <LogViewer />
                  </SettingBlock>
                </SettingsCard>
              </SettingsSection>

              {matchingSections.length === 0 && (
                <div
                  role="status"
                  className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground"
                >
                  <LuSearch className="size-5" />
                  {t("common.noResults")}
                </div>
              )}
              {systemInfo && !needle && (
                <div
                  data-slot="settings-system-info"
                  className="flex items-center gap-2 px-1 text-xs text-muted-foreground"
                >
                  <span className="min-w-0 truncate font-mono select-all">
                    {systemLine}
                  </span>
                  <CopyToClipboard
                    text={systemLine}
                    variant="subtle"
                    className="size-6 rounded-md"
                  />
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <DnsBlocklistDialog
        isOpen={dnsBlocklistDialogOpen}
        onClose={() => setDnsBlocklistDialogOpen(false)}
      />
    </>
  );
}

function SwitchRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  icon,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  icon?: ReactNode;
}) {
  return (
    <SettingRow
      htmlFor={id}
      label={label}
      description={description}
      icon={icon}
    >
      <AnimatedSwitch
        id={id}
        aria-label={label}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
      />
    </SettingRow>
  );
}

function StatusChip({
  tone,
  children,
}: {
  tone: "success";
  children: ReactNode;
}) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-success/10 px-2.5 text-xs font-medium text-success-text">
      <StatusLight tone={tone} />
      {children}
    </span>
  );
}

function SectionNote({ children }: { children: ReactNode }) {
  return (
    <p className="px-1 text-xs leading-relaxed text-pretty text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * The commercial license: a paid plan, the trial and how much of it is left,
 * or the expired trial.
 */
function CommercialRow({
  plan,
  trialStatus,
}: {
  plan: string;
  trialStatus: ReturnType<typeof useCommercialTrial>["trialStatus"];
}) {
  const { t } = useTranslation();
  if (plan !== "free") {
    // A paid plan supersedes the local trial; "Trial expired" reads like a
    // billing error to a paying customer.
    return (
      <SettingRow
        target="commercial"
        label={t("settings.commercial.subscriptionActive", {
          plan: planLabel(t, plan),
        })}
        description={t("settings.commercial.subscriptionActiveDescription")}
        icon={
          <RowIcon tone="success">
            <LuBriefcaseBusiness />
          </RowIcon>
        }
      />
    );
  }
  if (trialStatus?.type === "Active") {
    return (
      <SettingRow
        target="commercial"
        label={t("settings.commercial.trialActive", {
          days: trialStatus.days_remaining,
          hours: trialStatus.hours_remaining,
        })}
        description={t("settings.commercial.trialActiveDescription")}
        icon={
          <RowIcon tone="primary">
            <LuBriefcaseBusiness />
          </RowIcon>
        }
      >
        <TrialMeter remainingSeconds={trialStatus.remaining_seconds} />
      </SettingRow>
    );
  }
  return (
    <SettingRow
      target="commercial"
      label={t("settings.commercial.trialExpired")}
      description={t("settings.commercial.trialExpiredDescription")}
      icon={
        <RowIcon tone="warning">
          <LuBriefcaseBusiness />
        </RowIcon>
      }
    />
  );
}

/** How much of the commercial trial is left, as a bar that fills in. */
function TrialMeter({ remainingSeconds }: { remainingSeconds: number }) {
  const animate = useMotionAllowed();
  const share = Math.min(
    1,
    Math.max(0, remainingSeconds / (TRIAL_DAYS * 24 * 60 * 60)),
  );
  return (
    <span
      aria-hidden="true"
      className="relative block h-1.5 w-32 overflow-hidden rounded-full bg-foreground/8"
    >
      <motion.span
        className="absolute inset-0 origin-left rounded-full bg-primary"
        initial={animate ? { scaleX: 0 } : false}
        animate={{ scaleX: share }}
        transition={
          animate
            ? { duration: MOTION_DURATION.draw, ease: MOTION_EASE_OUT }
            : { duration: 0 }
        }
      />
    </span>
  );
}
