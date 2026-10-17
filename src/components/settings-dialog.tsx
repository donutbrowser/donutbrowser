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
  LuBriefcaseBusiness,
  LuCamera,
  LuCopy,
  LuEyeOff,
  LuGlobe,
  LuLanguages,
  LuLockKeyhole,
  LuMic,
  LuMonitor,
  LuPalette,
  LuPlug,
  LuSearch,
  LuShieldBan,
  LuShieldCheck,
  LuTrash2,
  LuVolume2,
  LuWrench,
  LuX,
} from "react-icons/lu";
import { DnsBlocklistDialog } from "@/components/dns-blocklist-dialog";
import { LoadingButton } from "@/components/loading-button";
import { EncryptionSettings } from "@/components/settings/encryption-settings";
import {
  ChoiceCard,
  ChoiceGroup,
  RowIcon,
  SegmentedControl,
  SettingBlock,
  SettingRow,
  SettingsCard,
  SettingsSection,
  useSettingsMotion,
} from "@/components/settings/settings-primitives";
import {
  type PendingChange,
  SettingsSaveBar,
} from "@/components/settings/settings-save-bar";
import {
  SoundSettings,
  soundDraft,
} from "@/components/settings/sound-settings";
import {
  ThemeColorEditor,
  ThemeModePicker,
  ThemePresetGallery,
} from "@/components/settings/theme-settings";
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
import { Input } from "@/components/ui/input";
import { ScrollStrip } from "@/components/ui/scroll-strip";
import { StatusLight } from "@/components/ui/settings-panel";
import { useCloudAuth } from "@/hooks/use-cloud-auth";
import { useCommercialTrial } from "@/hooks/use-commercial-trial";
import { useLanguage } from "@/hooks/use-language";
import type { PermissionType } from "@/hooks/use-permissions";
import { usePermissions } from "@/hooks/use-permissions";
import type { SupportedLanguage } from "@/i18n";
import { translateBackendError } from "@/lib/backend-errors";
import { effectivePlanOf } from "@/lib/entitlements";
import { MOTION_EASE_OUT, MOTION_SPRING_POSITION } from "@/lib/motion";
import {
  applyThemeColors,
  clearThemeColors,
  getThemeByColors,
  getThemeById,
  normalizeThemeColors,
  withThemeTransition,
} from "@/lib/themes";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import {
  applySoundSettings,
  type SoundSettings as SoundFields,
} from "@/lib/ui-sounds";
import { cn } from "@/lib/utils";
import type { SetDefaultBrowserOutcome } from "@/types";

interface AppSettings extends SoundFields {
  set_as_default_browser: boolean;
  theme: string;
  custom_theme?: Record<string, string>;
  api_enabled: boolean;
  api_port: number;
  api_token?: string;
  disable_auto_updates?: boolean;
  keep_decrypted_profiles_in_ram?: boolean;
  fingerprint_gate_disabled?: boolean;
  vpn_extension_warning_disabled?: boolean;
  require_route_for_launch?: boolean;
  trash_retention_days?: number;
  record_traffic_domains?: boolean;
}

/** The retention choices offered, in days. 0 turns the trash off. */
const TRASH_RETENTION_DAYS = [0, 1, 7, 14, 30, 90] as const;
const DEFAULT_TRASH_RETENTION_DAYS = 30;
/** The commercial trial length, to draw how much of it is left. */
const TRIAL_DAYS = 14;

interface CustomThemeState {
  selectedThemeId: string | null;
  colors: Record<string, string>;
}

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
    search: ["settings.appearance"],
  },
  {
    id: "language",
    title: "settings.language.title",
    icon: <LuLanguages />,
    search: ["settings.language"],
  },
  {
    id: "sounds",
    title: "settings.sounds.title",
    icon: <LuVolume2 />,
    search: ["settings.sounds"],
  },
  {
    id: "default",
    title: "settings.defaultBrowser.title",
    icon: <LuGlobe />,
    search: ["settings.defaultBrowser"],
  },
  {
    id: "permissions",
    title: "settings.permissions.title",
    icon: <LuShieldCheck />,
    search: ["settings.permissions"],
  },
  {
    id: "integrations",
    title: "settings.integrations.title",
    icon: <LuPlug />,
    search: ["settings.integrations"],
  },
  {
    id: "dns",
    title: "dnsBlocklist.title",
    icon: <LuShieldBan />,
    search: [
      "dnsBlocklist.title",
      "dnsBlocklist.settingsDescription",
      "settings.dns",
    ],
  },
  {
    id: "encryption",
    title: "settings.encryption.title",
    icon: <LuLockKeyhole />,
    search: ["settings.encryption"],
  },
  {
    id: "commercial",
    title: "settings.commercial.title",
    icon: <LuBriefcaseBusiness />,
    search: ["settings.commercial"],
  },
  {
    id: "privacy",
    title: "settings.privacy.title",
    icon: <LuEyeOff />,
    search: [
      "settings.privacy",
      "settings.trashRetention",
      "settings.trashRetentionDescription",
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
    ],
  },
];

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onIntegrationsOpen?: () => void;
  subPage?: boolean;
  /** A section to scroll to and focus as soon as the page opens. */
  initialSection?: string | null;
}

export function SettingsDialog({
  isOpen,
  onClose,
  onIntegrationsOpen,
  subPage,
  initialSection = null,
}: SettingsDialogProps) {
  const [settings, setSettings] = useState<AppSettings>({
    set_as_default_browser: false,
    theme: "system",
    custom_theme: undefined,
    api_enabled: false,
    api_port: 10108,
    api_token: undefined,
  });
  const [originalSettings, setOriginalSettings] = useState<AppSettings>({
    set_as_default_browser: false,
    theme: "system",
    custom_theme: undefined,
    api_enabled: false,
    api_port: 10108,
    api_token: undefined,
  });
  const [customThemeState, setCustomThemeState] = useState<CustomThemeState>({
    selectedThemeId: null,
    colors: {},
  });
  const [isDefaultBrowser, setIsDefaultBrowser] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState("");
  const [jumpTo, setJumpTo] = useState<string | null>(initialSection);
  const sectionsRef = useRef<HTMLFieldSetElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // The section the reader is in, so the nav can point at it. A click pins
  // its target until the reader scrolls away, because the last sections can
  // never reach the top of the scroller on their own.
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const pinnedSectionRef = useRef<{ id: string; scrollTop: number } | null>(
    null,
  );
  const animateNav = useSettingsMotion();
  const [isSettingDefault, setIsSettingDefault] = useState(false);
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [isClearingTraffic, setIsClearingTraffic] = useState(false);
  const [requestingPermission, setRequestingPermission] =
    useState<PermissionType | null>(null);
  const [dnsBlocklistDialogOpen, setDnsBlocklistDialogOpen] = useState(false);
  const [hasE2ePassword, setHasE2ePassword] = useState(false);
  // Theme-restore guards: settings load asynchronously, and the dialog can be
  // unmounted directly by rail navigation (bypassing handleClose). Refs mirror
  // the loaded state so the unmount cleanup can restore the persisted theme.
  const [hasLoadedSettings, setHasLoadedSettings] = useState(false);
  const hasLoadedSettingsRef = useRef(false);
  const originalSettingsRef = useRef<AppSettings | null>(null);
  const [systemInfo, setSystemInfo] = useState<{
    app_version: string;
    os: string;
    arch: string;
    portable: boolean;
  } | null>(null);

  const { t } = useTranslation();
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
  const [originalLanguage, setOriginalLanguage] = useState<string | null>(null);

  // `animate: false` on the restore paths. Opening Settings re-applies the
  // theme already on screen, so a whole-document cross-fade to an identical
  // palette animates nothing. Worse, the mount effect below did it twice in a
  // row, and the second transition aborts the first mid-snapshot.
  const applyCustomTheme = useCallback(
    (vars: Record<string, string>, options?: { animate?: boolean }) => {
      const apply = () => {
        applyThemeColors(vars);
      };
      if (options?.animate === false) {
        apply();
        return;
      }
      withThemeTransition(apply);
    },
    [],
  );

  const clearCustomTheme = useCallback((options?: { animate?: boolean }) => {
    if (options?.animate === false) {
      clearThemeColors();
      return;
    }
    withThemeTransition(clearThemeColors);
  }, []);

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      const appSettings = await invoke<AppSettings>("get_app_settings");
      const tokyoNightTheme = getThemeById("tokyo-night");
      if (!tokyoNightTheme) {
        throw new Error("Tokyo Night theme not found");
      }
      const merged: AppSettings = {
        ...appSettings,
        custom_theme:
          appSettings.custom_theme &&
          Object.keys(appSettings.custom_theme).length > 0
            ? normalizeThemeColors(appSettings.custom_theme)
            : tokyoNightTheme.colors,
      };
      // One-shot migration off the old localStorage flag. Without it, a user
      // who explicitly turned the warning off would start getting hard blocks
      // after updating — the single most likely support complaint here.
      let migrated = merged;
      try {
        if (
          localStorage.getItem("consistency-warn-disabled") === "1" &&
          !merged.fingerprint_gate_disabled
        ) {
          migrated = { ...merged, fingerprint_gate_disabled: true };
          await invoke<AppSettings>("save_app_settings", {
            settings: migrated,
          });
        }
        localStorage.removeItem("consistency-warn-disabled");
      } catch (err) {
        console.warn("Failed to migrate consistency warning preference:", err);
      }

      setSettings(migrated);
      setOriginalSettings(migrated);
      originalSettingsRef.current = migrated;
      hasLoadedSettingsRef.current = true;
      setHasLoadedSettings(true);

      // Initialize custom theme state
      if (merged.theme === "custom" && merged.custom_theme) {
        const matchingTheme = getThemeByColors(merged.custom_theme);
        setCustomThemeState({
          selectedThemeId: matchingTheme?.id ?? null,
          colors: merged.custom_theme,
        });
        // Keep the user's custom colors applied while Settings is open —
        // without this the page shows the default palette until save/close.
        applyCustomTheme(merged.custom_theme);
      } else if (merged.theme === "custom") {
        // Initialize with Tokyo Night if no custom theme exists
        setCustomThemeState({
          selectedThemeId: "tokyo-night",
          colors: tokyoNightTheme.colors,
        });
      }
      // Check E2E password status
      try {
        const hasPassword = await invoke<boolean>("check_has_e2e_password");
        setHasE2ePassword(hasPassword);
      } catch {
        setHasE2ePassword(false);
      }
      // Load system info
      try {
        const info = await invoke<{
          app_version: string;
          os: string;
          arch: string;
          portable: boolean;
        }>("get_system_info");
        setSystemInfo(info);
      } catch {
        setSystemInfo(null);
      }
    } catch (error) {
      console.error("Failed to load settings:", error);
    } finally {
      setIsLoading(false);
    }
  }, [applyCustomTheme]);

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
      // of the two happened. Saying nothing at all is what left the user
      // watching the badge stay "Inactive" with no explanation.
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
        description:
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : t("common.errors.unknown"),
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
      showErrorToast(
        error instanceof Error ? error.message : t("common.errors.unknown"),
      );
    } finally {
      setIsClearingTraffic(false);
    }
  }, [t]);

  const handleClearCache = useCallback(async () => {
    setIsClearingCache(true);
    try {
      await invoke("clear_all_version_cache_and_refetch");
      // Also clear traffic stats cache
      await invoke("clear_all_traffic_stats");
      // Don't show immediate success toast - let the version update progress events handle it
    } catch (error) {
      console.error("Failed to clear cache:", error);
      showErrorToast(t("settings.advanced.clearCacheFailed"), {
        description:
          error instanceof Error ? error.message : t("common.errors.unknown"),
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

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      // Update settings with current custom theme state
      let settingsToSave: AppSettings = {
        ...settings,
        custom_theme:
          settings.theme === "custom"
            ? customThemeState.colors
            : settings.custom_theme,
      };

      const savedSettings = await invoke<AppSettings>("save_app_settings", {
        settings: settingsToSave,
      });

      // Update settings with any generated tokens
      setSettings(savedSettings);
      applySoundSettings(savedSettings);
      settingsToSave = savedSettings;
      setOriginalSettings(savedSettings);
      originalSettingsRef.current = savedSettings;
      // Pass the actual theme value through. Calling setTheme("dark") here
      // when the user is on "custom" pushes the provider state to "dark",
      // which triggers its clear-custom-vars effect and wipes the CSS
      // variables we set just below — that's the bug where saving a custom
      // theme made it disappear until the app was restarted.
      setTheme(settings.theme);

      // Apply or clear custom variables only on Save
      if (settings.theme === "custom") {
        if (Object.keys(customThemeState.colors).length > 0) {
          try {
            clearThemeColors();
            applyThemeColors(customThemeState.colors);
          } catch {
            /* empty */
          }
        }
      } else {
        try {
          clearThemeColors();
        } catch {
          /* empty */
        }
      }

      // Save language if changed
      if (selectedLanguage !== originalLanguage) {
        await changeLanguage(
          selectedLanguage === "system"
            ? null
            : (selectedLanguage as SupportedLanguage),
        );
        setOriginalLanguage(selectedLanguage);
      }

      setOriginalSettings(settingsToSave);
      // Keep the ref in sync so the unmount-restore effect re-applies the
      // just-SAVED theme, not the pre-save one (which reverted the theme
      // until app restart).
      originalSettingsRef.current = settingsToSave;
      setSaved(true);
      if (!subPage) onClose();
    } catch (error) {
      console.error("Failed to save settings:", error);
      const message = translateBackendError(t, error);
      setSaveError(message);
      showErrorToast(t("appFeedback.saveFailed"), { description: message });
    } finally {
      setIsSaving(false);
    }
  }, [
    onClose,
    setTheme,
    settings,
    customThemeState,
    selectedLanguage,
    originalLanguage,
    changeLanguage,
    subPage,
    t,
  ]);

  const updateSetting = useCallback(
    (
      key: keyof AppSettings,
      value: boolean | number | string | Record<string, string> | undefined,
    ) => {
      setSaveError(null);
      setSettings((prev) => ({ ...prev, [key]: value as unknown as never }));
    },
    [],
  );

  const discardChanges = useCallback(() => {
    // Restore original theme when closing without saving
    // Only a revert the user can see is worth animating.
    const changed = originalSettings.theme !== settings.theme;
    if (originalSettings.theme === "custom" && originalSettings.custom_theme) {
      applyCustomTheme(originalSettings.custom_theme, { animate: changed });
    } else {
      clearCustomTheme({ animate: false });
      setTheme(originalSettings.theme, { animate: changed });
    }

    setSettings(originalSettings);
    setSelectedLanguage(originalLanguage);
    setCustomThemeState({
      selectedThemeId: originalSettings.custom_theme
        ? (getThemeByColors(originalSettings.custom_theme)?.id ?? null)
        : null,
      colors: originalSettings.custom_theme ?? {},
    });
    setSaveError(null);
    setSaved(false);
  }, [
    applyCustomTheme,
    clearCustomTheme,
    originalSettings,
    originalLanguage,
    setTheme,
    settings.theme,
  ]);

  const handleClose = useCallback(() => {
    discardChanges();
    onClose();
  }, [discardChanges, onClose]);

  // Only clear custom theme when switching away from custom, don't apply live
  // changes. Gated on the async settings load: before it resolves the state
  // still holds the "system" default, and clearing then wipes the user's
  // custom theme vars on every Settings visit (the theme-reverts-to-dark bug).
  //
  // This effect is both the restore-on-open and the live switch when the user
  // picks a theme, so it animates only a real change: the first run after the
  // settings load is re-applying the palette already on screen. Clearing the
  // inline custom vars is never the animated half — switching to a stylesheet
  // palette makes them invisible either way, and running two transitions
  // back to back just aborts the first one mid-snapshot.
  const appliedThemeRef = useRef<string | null>(null);
  useEffect(() => {
    if (hasLoadedSettings && settings.theme !== "custom") {
      const previous = appliedThemeRef.current;
      appliedThemeRef.current = settings.theme;
      clearCustomTheme({ animate: false });
      setTheme(settings.theme, {
        animate: previous !== null && previous !== settings.theme,
      });
    }
  }, [hasLoadedSettings, settings.theme, clearCustomTheme, setTheme]);

  // Unmount-safe theme restore: rail navigation unmounts this dialog without
  // calling handleClose, which used to leave the theme vars wiped for the
  // rest of the session.
  useEffect(() => {
    return () => {
      const s = originalSettingsRef.current;
      if (!hasLoadedSettingsRef.current || !s) return;
      if (s.theme === "custom" && s.custom_theme) {
        applyThemeColors(s.custom_theme);
      } else {
        // A non-custom persisted theme (light/dark/system) uses the
        // stylesheet palette — strip any leftover inline custom vars so a
        // just-saved switch away from custom isn't reverted on unmount.
        clearThemeColors();
        setTheme(s.theme, { animate: false });
      }
    };
  }, [setTheme]);

  useEffect(() => {
    if (isOpen) {
      loadSettings().catch((err: unknown) => {
        console.error(err);
      });
      checkDefaultBrowserStatus().catch((err: unknown) => {
        console.error(err);
      });

      // Re-check periodically so the badge follows a change the user made in
      // their desktop settings. Ten seconds rather than two: on Linux each
      // check is three subprocesses, and nobody flips their default browser
      // often enough to notice the difference.
      const intervalId = setInterval(() => {
        checkDefaultBrowserStatus().catch((err: unknown) => {
          console.error(err);
        });
      }, 10000);

      // Cleanup interval on component unmount or dialog close
      return () => {
        clearInterval(intervalId);
      };
    }
  }, [isOpen, checkDefaultBrowserStatus, loadSettings]);

  // Initialize language selection when dialog opens or language loads
  useEffect(() => {
    if (isOpen && !isLanguageLoading) {
      setSelectedLanguage(currentLanguage);
      setOriginalLanguage(currentLanguage);
    }
  }, [isOpen, currentLanguage, isLanguageLoading]);

  const draftColors =
    settings.theme === "custom"
      ? customThemeState.colors
      : (settings.custom_theme ?? {});
  const savedColors = originalSettings.custom_theme ?? {};
  const themeChanged =
    settings.theme !== originalSettings.theme ||
    Object.keys(draftColors).length !== Object.keys(savedColors).length ||
    Object.entries(draftColors).some(
      ([key, value]) => savedColors[key] !== value,
    );
  const sounds = soundDraft(settings);
  const savedSounds = soundDraft(originalSettings);
  const flagChanged = (key: keyof AppSettings, fallback = false) =>
    Boolean(settings[key] ?? fallback) !==
    Boolean(originalSettings[key] ?? fallback);
  const changes: Array<PendingChange & { key: string; changed: boolean }> = [
    {
      key: "theme",
      changed: themeChanged,
      label: t("settings.appearance.title"),
      section: "appearance",
    },
    {
      key: "language",
      changed: selectedLanguage !== originalLanguage,
      label: t("settings.language.title"),
      section: "language",
    },
    ...(
      [
        ["ui_sounds", "settings.sounds.enabled"],
        ["ui_sound_volume", "settings.sounds.volume"],
        ["ui_sound_pack", "settings.sounds.pack"],
        ["ui_sound_interface", "settings.sounds.categories.interface.label"],
        ["ui_sound_feedback", "settings.sounds.categories.feedback.label"],
        ["ui_sound_events", "settings.sounds.categories.events.label"],
      ] as const
    ).map(([key, label]) => ({
      key,
      changed: sounds[key] !== savedSounds[key],
      label: t(label),
      section: "sounds",
    })),
    {
      key: "api_enabled",
      changed: flagChanged("api_enabled"),
      label: t("settings.integrations.title"),
      section: "integrations",
    },
    {
      key: "require_route_for_launch",
      changed: flagChanged("require_route_for_launch"),
      label: t("settings.privacy.requireRoute"),
      section: "privacy",
    },
    {
      key: "fingerprint_gate_disabled",
      changed: flagChanged("fingerprint_gate_disabled"),
      label: t("settings.privacy.consistencyWarning"),
      section: "privacy",
    },
    {
      key: "vpn_extension_warning_disabled",
      changed: flagChanged("vpn_extension_warning_disabled"),
      label: t("settings.privacy.vpnExtensionWarning"),
      section: "privacy",
    },
    {
      key: "record_traffic_domains",
      changed: flagChanged("record_traffic_domains", true),
      label: t("settings.privacy.recordSites"),
      section: "privacy",
    },
    {
      key: "trash_retention_days",
      changed:
        (settings.trash_retention_days ?? DEFAULT_TRASH_RETENTION_DAYS) !==
        (originalSettings.trash_retention_days ?? DEFAULT_TRASH_RETENTION_DAYS),
      label: t("settings.trashRetention"),
      section: "privacy",
    },
    {
      key: "disable_auto_updates",
      changed: flagChanged("disable_auto_updates"),
      label: t("settings.disableAutoUpdates"),
      section: "advanced",
    },
    {
      key: "keep_decrypted_profiles_in_ram",
      changed: flagChanged("keep_decrypted_profiles_in_ram"),
      label: t("settings.keepDecryptedProfilesInRam"),
      section: "advanced",
    },
  ].filter((change) => change.changed);
  const changedKeys = new Set(changes.map((change) => change.key));
  const changedSections = new Set(changes.map((change) => change.section));
  const isChanged = (key: string) => changedKeys.has(key);

  const sections = SECTIONS.filter(
    ({ id }) =>
      (id !== "default" || !systemInfo?.portable) &&
      (id !== "permissions" || isMacOS),
  );
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

  useEffect(() => {
    if (!jumpTo) return;
    const section = sectionsRef.current?.querySelector<HTMLElement>(
      `[data-settings-section="${jumpTo}"]`,
    );
    section?.scrollIntoView({ block: "start" });
    section?.focus({ preventScroll: true });
    if (scrollerRef.current) {
      pinnedSectionRef.current = {
        id: jumpTo,
        scrollTop: scrollerRef.current.scrollTop,
      };
    }
    setActiveSection(jumpTo);
    setJumpTo(null);
  }, [jumpTo]);

  const jump = (id: string) => {
    setSearch("");
    setJumpTo(id);
  };

  const pickTheme = (value: string) => {
    updateSetting("theme", value);
    if (value === "custom" && settings.theme !== "custom") {
      const colors =
        settings.custom_theme ?? getThemeById("tokyo-night")?.colors ?? {};
      setCustomThemeState({
        selectedThemeId: getThemeByColors(colors)?.id ?? null,
        colors,
      });
    }
  };

  const plan = cloudUser ? effectivePlanOf(cloudUser) : "free";
  const appliesImmediately = (
    <span className="text-right text-[11px] leading-tight text-muted-foreground">
      {t("appFeedback.appliesImmediately")}
    </span>
  );
  const systemLine = systemInfo
    ? `Donut Browser ${systemInfo.app_version} · ${systemInfo.os} ${systemInfo.arch}${systemInfo.portable ? " (portable)" : ""}`
    : "";

  return (
    <>
      <Dialog open={isOpen} onOpenChange={handleClose} subPage={subPage}>
        <DialogContent className="flex max-h-[calc(100vh-5rem)] max-w-xl flex-col">
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
                  className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
                        "relative isolate shrink-0 rounded-md px-2 py-1 text-xs whitespace-nowrap transition-[color,opacity] duration-150 focus-visible:outline-2 focus-visible:outline-ring",
                        active
                          ? "text-accent-foreground"
                          : "text-muted-foreground hover:text-foreground",
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
                          className="absolute inset-0 -z-10 rounded-md bg-accent"
                        />
                      )}
                      {t(title)}
                      {changedSections.has(id) && (
                        <motion.span
                          aria-hidden="true"
                          data-slot="settings-nav-changed"
                          initial={animateNav ? { scale: 0 } : false}
                          animate={{ scale: 1 }}
                          transition={{
                            type: "spring",
                            stiffness: 600,
                            damping: 26,
                          }}
                          className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
                        />
                      )}
                    </button>
                  );
                })}
              </ScrollStrip>
            </nav>
          </div>

          {/* The scroller spans the full width (so the wheel works over the
              side gutters); the width cap lives on the inner column. Fusing
              them was the dead-wheel-zone bug. */}
          <div
            ref={scrollerRef}
            data-slot="settings-scroller"
            onScroll={syncActiveSection}
            className={cn(
              "min-h-0 flex-1 overflow-y-auto",
              subPage ? "py-2" : "py-4",
            )}
          >
            <fieldset
              ref={sectionsRef}
              disabled={isSaving || isLoading}
              className={cn(
                "grid min-w-0 gap-8 pb-6",
                subPage && "mx-auto w-full max-w-4xl",
              )}
            >
              <SettingsSection {...sectionProps("appearance")}>
                <SettingsCard>
                  <SettingBlock
                    label={t("settings.appearance.theme")}
                    description={t("settings.appearance.themeDescription")}
                    changed={isChanged("theme")}
                  >
                    <ThemeModePicker
                      value={settings.theme}
                      onValueChange={pickTheme}
                      customColors={
                        settings.theme === "custom"
                          ? customThemeState.colors
                          : (settings.custom_theme ?? {})
                      }
                    />
                  </SettingBlock>
                  <AnimatedDisclosureContent
                    open={settings.theme === "custom"}
                    className="divide-y divide-foreground/6"
                  >
                    <SettingBlock label={t("settings.appearance.themePreset")}>
                      <ThemePresetGallery
                        selectedId={customThemeState.selectedThemeId}
                        colors={customThemeState.colors}
                        onSelect={(id) => {
                          const theme = id ? getThemeById(id) : undefined;
                          setCustomThemeState((prev) =>
                            theme
                              ? {
                                  selectedThemeId: theme.id,
                                  colors: theme.colors,
                                }
                              : { ...prev, selectedThemeId: null },
                          );
                        }}
                      />
                    </SettingBlock>
                    <SettingBlock label={t("settings.appearance.customColors")}>
                      <ThemeColorEditor
                        colors={customThemeState.colors}
                        onChange={({ colors, presetId }) =>
                          setCustomThemeState({
                            selectedThemeId: presetId,
                            colors,
                          })
                        }
                      />
                    </SettingBlock>
                  </AnimatedDisclosureContent>
                </SettingsCard>
              </SettingsSection>

              <SettingsSection {...sectionProps("language")}>
                <SettingsCard>
                  <SettingBlock
                    label={t("settings.language.interface")}
                    description={t("settings.language.description")}
                    changed={isChanged("language")}
                  >
                    <ChoiceGroup
                      value={selectedLanguage ?? "system"}
                      onValueChange={setSelectedLanguage}
                      label={t("settings.language.interface")}
                      slot="settings-language"
                      className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-1.5"
                    >
                      <ChoiceCard
                        value="system"
                        slot="settings-language-option"
                        className="flex items-center gap-2 px-3 py-2 hover:bg-foreground/4"
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
                          className="flex flex-col px-3 py-2 hover:bg-foreground/4"
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
                  <SoundSettings
                    draft={sounds}
                    onChange={(patch) => {
                      setSaveError(null);
                      setSettings((prev) => ({ ...prev, ...patch }));
                    }}
                    isChanged={isChanged}
                  />
                </SettingsCard>
              </SettingsSection>

              {!systemInfo?.portable && (
                <SettingsSection
                  {...sectionProps("default")}
                  aside={appliesImmediately}
                >
                  <SettingsCard>
                    <SettingRow
                      slot="settings-default-browser"
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
                  </SettingsCard>
                </SettingsSection>
              )}

              {isMacOS && (
                <SettingsSection
                  {...sectionProps("permissions")}
                  aside={appliesImmediately}
                >
                  <SettingsCard>
                    {PERMISSION_TYPES.map((type) => {
                      const granted =
                        type === "microphone"
                          ? isMicrophoneAccessGranted
                          : isCameraAccessGranted;
                      return (
                        <SettingRow
                          key={type}
                          label={t(`settings.permissions.${type}`)}
                          description={t(
                            `settings.permissions.${type}Description`,
                          )}
                          icon={
                            <RowIcon tone={granted ? "success" : "muted"}>
                              {type === "microphone" ? <LuMic /> : <LuCamera />}
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
                </SettingsSection>
              )}

              <SettingsSection {...sectionProps("integrations")}>
                <SettingsCard>
                  <SettingRow
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

              <SettingsSection {...sectionProps("dns")}>
                <SettingsCard>
                  <SettingRow
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
                </SettingsCard>
              </SettingsSection>

              <SettingsSection
                {...sectionProps("encryption")}
                aside={appliesImmediately}
              >
                <EncryptionSettings
                  canUseEncryption={canUseEncryption}
                  hasPassword={hasE2ePassword}
                  onHasPasswordChange={setHasE2ePassword}
                />
              </SettingsSection>

              <SettingsSection {...sectionProps("commercial")}>
                <SettingsCard>
                  {plan !== "free" ? (
                    // A paid plan supersedes the local commercial trial, which
                    // only gates commercial use until the user subscribes.
                    // "Trial expired" reads like a billing error to a paying
                    // customer, so they see their subscription instead.
                    <SettingRow
                      label={t("settings.commercial.subscriptionActive", {
                        plan,
                      })}
                      description={t(
                        "settings.commercial.subscriptionActiveDescription",
                      )}
                      icon={
                        <RowIcon tone="success">
                          <LuBriefcaseBusiness />
                        </RowIcon>
                      }
                    />
                  ) : trialStatus?.type === "Active" ? (
                    <SettingRow
                      label={t("settings.commercial.trialActive", {
                        days: trialStatus.days_remaining,
                        hours: trialStatus.hours_remaining,
                      })}
                      description={t(
                        "settings.commercial.trialActiveDescription",
                      )}
                      icon={
                        <RowIcon tone="primary">
                          <LuBriefcaseBusiness />
                        </RowIcon>
                      }
                    >
                      <TrialMeter
                        remainingSeconds={trialStatus.remaining_seconds}
                      />
                    </SettingRow>
                  ) : (
                    <SettingRow
                      label={t("settings.commercial.trialExpired")}
                      description={t(
                        "settings.commercial.trialExpiredDescription",
                      )}
                      icon={
                        <RowIcon tone="warning">
                          <LuBriefcaseBusiness />
                        </RowIcon>
                      }
                    />
                  )}
                </SettingsCard>
              </SettingsSection>

              <SettingsSection {...sectionProps("privacy")}>
                <SettingsCard>
                  <SwitchRow
                    id="settings-require-route"
                    label={t("settings.privacy.requireRoute")}
                    description={t("settings.privacy.requireRouteDescription")}
                    changed={isChanged("require_route_for_launch")}
                    checked={settings.require_route_for_launch ?? false}
                    onCheckedChange={(v) =>
                      updateSetting("require_route_for_launch", v)
                    }
                  />
                  <SwitchRow
                    id="settings-consistency-warning"
                    label={t("settings.privacy.consistencyWarning")}
                    description={t(
                      "settings.privacy.consistencyWarningDescription",
                    )}
                    changed={isChanged("fingerprint_gate_disabled")}
                    checked={!(settings.fingerprint_gate_disabled ?? false)}
                    onCheckedChange={(v) =>
                      updateSetting("fingerprint_gate_disabled", !v)
                    }
                  />
                  <SwitchRow
                    id="settings-vpn-extension-warning"
                    label={t("settings.privacy.vpnExtensionWarning")}
                    description={t(
                      "settings.privacy.vpnExtensionWarningDescription",
                    )}
                    changed={isChanged("vpn_extension_warning_disabled")}
                    checked={
                      !(settings.vpn_extension_warning_disabled ?? false)
                    }
                    onCheckedChange={(v) =>
                      updateSetting("vpn_extension_warning_disabled", !v)
                    }
                  />
                  <SwitchRow
                    id="settings-record-sites"
                    label={t("settings.privacy.recordSites")}
                    description={t("settings.privacy.recordSitesDescription")}
                    changed={isChanged("record_traffic_domains")}
                    checked={settings.record_traffic_domains ?? true}
                    onCheckedChange={(v) =>
                      updateSetting("record_traffic_domains", v)
                    }
                  />
                  <SettingRow
                    htmlFor="trash-retention"
                    label={t("settings.trashRetention")}
                    description={t("settings.trashRetentionDescription")}
                    changed={isChanged("trash_retention_days")}
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
                        updateSetting("trash_retention_days", days)
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
              </SettingsSection>

              <SettingsSection {...sectionProps("advanced")}>
                <SettingsCard>
                  {!isLinux && (
                    <SwitchRow
                      id="disable-auto-updates"
                      label={t("settings.disableAutoUpdates")}
                      description={t("settings.disableAutoUpdatesDescription")}
                      changed={isChanged("disable_auto_updates")}
                      checked={settings.disable_auto_updates ?? false}
                      onCheckedChange={(v) =>
                        updateSetting("disable_auto_updates", v)
                      }
                    />
                  )}
                  <SwitchRow
                    id="keep-decrypted-profiles-in-ram"
                    label={t("settings.keepDecryptedProfilesInRam")}
                    description={t(
                      "settings.keepDecryptedProfilesInRamDescription",
                    )}
                    changed={isChanged("keep_decrypted_profiles_in_ram")}
                    checked={settings.keep_decrypted_profiles_in_ram ?? false}
                    onCheckedChange={(v) =>
                      updateSetting("keep_decrypted_profiles_in_ram", v)
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
                          showErrorToast(String(err));
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
                          showErrorToast(String(err));
                        }
                      }}
                    >
                      {t("settings.advanced.openLogDir")}
                    </Button>
                  </SettingRow>
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
            </fieldset>
          </div>

          <SettingsSaveBar
            pendingChanges={changes}
            isLoading={isLoading}
            isSaving={isSaving}
            saved={saved}
            saveError={saveError}
            onSave={() => {
              void handleSave();
            }}
            onDiscard={discardChanges}
            onJump={jump}
            onCancel={subPage ? undefined : handleClose}
          />
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
  changed,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  changed: boolean;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <SettingRow
      htmlFor={id}
      label={label}
      description={description}
      changed={changed}
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

/** How much of the commercial trial is left, as a bar that fills in. */
function TrialMeter({ remainingSeconds }: { remainingSeconds: number }) {
  const animate = useSettingsMotion();
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
        transition={{ duration: 0.6, ease: MOTION_EASE_OUT }}
      />
    </span>
  );
}
