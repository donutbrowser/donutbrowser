"use client";

import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion } from "motion/react";
import type * as React from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuClock,
  LuEllipsis,
  LuFlame,
  LuFolder,
  LuGlobe,
  LuLayoutTemplate,
  LuLoaderCircle,
  LuLock,
  LuLockOpen,
  LuMinus,
  LuPlus,
  LuShieldCheck,
  LuTrash2,
  LuTriangleAlert,
  LuX,
} from "react-icons/lu";
import { DnsServerField } from "@/components/dns-server-field";
import { EphemeralStorageNotice } from "@/components/ephemeral-storage-notice";
import { LoadingButton } from "@/components/loading-button";
import { ProfileGlyph } from "@/components/profile-glyph";
import { ProxyFormDialog } from "@/components/proxy-form-dialog";
import {
  AnimatedDisclosureChevron,
  AnimatedDisclosureContent,
} from "@/components/ui/animated-disclosure";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SoftFields } from "@/components/ui/field-variant";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ProBadge } from "@/components/ui/pro-badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WayfernConfigForm } from "@/components/wayfern-config-form";
import { useBrowserDownload } from "@/hooks/use-browser-download";
import { useGroupEvents } from "@/hooks/use-group-events";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { useProfileTemplates } from "@/hooks/use-profile-templates";
import { useProxyEvents } from "@/hooks/use-proxy-events";
import { useEntityTrash } from "@/hooks/use-trash-events";
import { useVpnEvents } from "@/hooks/use-vpn-events";
import { translateBackendError } from "@/lib/backend-errors";
import { getOSDisplayName, getOSIcon } from "@/lib/browser-utils";
import { DNS_BLOCKLIST_LEVELS } from "@/lib/dns-blocklist-levels";
import { MOTION_DURATION, MOTION_EASE_OUT, MOTION_SPRING } from "@/lib/motion";
import { startPagesFromText } from "@/lib/start-pages";
import { notifySystem } from "@/lib/system-notify";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type {
  BrowserReleaseTypes,
  BulkCreateResult,
  ProfileTemplate,
  TemplateSettings,
  WayfernConfig,
  WayfernOS,
} from "@/types";

const PASSWORD_MIN_LEN = 8;
/** The most profiles one bulk creation makes; the backend holds the same cap. */
const MAX_BULK_CREATE = 100;

const OS_OPTIONS: WayfernOS[] = ["windows", "macos", "linux", "android", "ios"];

const getCurrentOS = (): WayfernOS => {
  if (typeof navigator === "undefined") return "linux";
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) return "windows";
  if (platform.includes("mac")) return "macos";
  return "linux";
};

const defaultWayfernConfig = (): WayfernConfig => ({
  os: getCurrentOS(),
  screen_max_width:
    typeof window === "undefined" ? undefined : window.screen.width,
  screen_max_height:
    typeof window === "undefined" ? undefined : window.screen.height,
});

interface CreateProfileDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateProfile: (profileData: {
    name: string;
    browserStr: "wayfern";
    version: string;
    releaseType: string;
    proxyId?: string;
    vpnId?: string;
    wayfernConfig?: WayfernConfig;
    /** `null`: the person picked "No group". */
    groupId?: string | null;
    extensionGroupId?: string;
    ephemeral?: boolean;
    dnsBlocklist?: string;
    dnsServer?: string;
    startUrls?: string[];
    launchHook?: string;
    password?: string;
  }) => Promise<void>;
  selectedGroupId?: string;
  crossOsUnlocked?: boolean;
}

export function CreateProfileDialog({
  isOpen,
  onClose,
  onCreateProfile,
  selectedGroupId,
  crossOsUnlocked = false,
}: CreateProfileDialogProps) {
  const { t } = useTranslation();
  const proxyListboxId = useId();
  const proxyLabelId = useId();
  const proxyValueId = useId();
  const osListboxId = useId();
  const osLabelId = useId();
  const osValueId = useId();
  const advancedOptionsId = useId();
  const motionAllowed = useMotionAllowed();
  const groupListboxId = useId();
  const groupValueId = useId();
  const [profileName, setProfileName] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedProxyId, setSelectedProxyId] = useState<string>();
  const [proxyPopoverOpen, setProxyPopoverOpen] = useState(false);
  const [morePopoverOpen, setMorePopoverOpen] = useState(false);
  // Where the new profiles go: the group the list shows, until changed.
  const [destinationGroupId, setDestinationGroupId] = useState<string | null>(
    null,
  );
  const [osPopoverOpen, setOsPopoverOpen] = useState(false);
  const [showProxyForm, setShowProxyForm] = useState(false);
  const [dnsBlocklist, setDnsBlocklist] = useState("");
  const [dnsServer, setDnsServer] = useState("");
  const [dnsServerValid, setDnsServerValid] = useState(true);
  const [startPages, setStartPages] = useState("");
  const [launchHook, setLaunchHook] = useState("");
  const [wayfernConfig, setWayfernConfig] =
    useState<WayfernConfig>(defaultWayfernConfig);
  const [isCreating, setIsCreating] = useState(false);
  const [ephemeral, setEphemeral] = useState(false);
  const templates = useProfileTemplates();
  const { request: requestTemplateTrash, remove: removeTemplates } =
    useEntityTrash("template");
  const [appliedTemplate, setAppliedTemplate] =
    useState<ProfileTemplate | null>(null);
  const [count, setCount] = useState(1);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [allowance, setAllowance] = useState<ProfileCreationAllowance | null>(
    null,
  );

  const loadAllowance = useCallback(async () => {
    try {
      setAllowance(
        await invoke<ProfileCreationAllowance>(
          "get_profile_creation_allowance",
        ),
      );
    } catch (error) {
      console.error("Failed to read the profile creation allowance:", error);
    }
  }, []);

  useEffect(() => {
    if (isOpen) void loadAllowance();
  }, [isOpen, loadAllowance]);

  // A browser that starts or stops changes whether a fingerprint can be made.
  useEffect(() => {
    if (!isOpen) return;
    let closed = false;
    let unlisten: (() => void) | undefined;
    void listen("profile-running-changed", () => void loadAllowance()).then(
      (stop) => {
        if (closed) stop();
        else unlisten = stop;
      },
    );
    return () => {
      closed = true;
      unlisten?.();
    };
  }, [isOpen, loadAllowance]);

  // The window frees a slot by itself, so look again once it should have.
  useEffect(() => {
    const wait = allowance?.retry_after_secs;
    if (!isOpen || wait == null) return;
    const timer = window.setTimeout(
      () => void loadAllowance(),
      wait * 1000 + 500,
    );
    return () => window.clearTimeout(timer);
  }, [isOpen, allowance, loadAllowance]);

  const overAllowance =
    allowance !== null && allowance.used >= allowance.per_hour;
  const hourlyCapReached = overAllowance && allowance.enforcement === "hard";
  const creatingQuickly = overAllowance && allowance.enforcement === "soft";
  const closeABrowser = allowance?.close_a_browser === true;

  // The wait in the hourly-limit notice counts down by the minute.
  useEffect(() => {
    if (!isOpen || !hourlyCapReached) return;
    const timer = window.setInterval(() => void loadAllowance(), 60_000);
    return () => window.clearInterval(timer);
  }, [isOpen, hourlyCapReached, loadAllowance]);

  // A batch stops at the hourly allowance on every plan, so it is never
  // offered past what is left.
  const maxCount =
    allowance === null
      ? MAX_BULK_CREATE
      : Math.max(1, Math.min(MAX_BULK_CREATE, allowance.remaining));
  const many = count > 1;
  useEffect(() => {
    setCount((current) => Math.min(current, maxCount));
  }, [maxCount]);
  const [enablePassword, setEnablePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [selectedExtensionGroupId, setSelectedExtensionGroupId] =
    useState<string>();
  const [extensionGroups, setExtensionGroups] = useState<
    { id: string; name: string; extension_ids: string[] }[]
  >([]);
  const [releaseTypes, setReleaseTypes] = useState<BrowserReleaseTypes>({});
  const [isLoadingReleaseTypes, setIsLoadingReleaseTypes] = useState(false);
  const [releaseTypesError, setReleaseTypesError] = useState(false);
  const versionRequestRef = useRef(0);
  // The dialog stays mounted; its lists load only while it is open.
  const { storedProxies } = useProxyEvents({ enabled: isOpen });
  const { vpnConfigs } = useVpnEvents({ enabled: isOpen });
  const { groups, isLoading: isLoadingGroups } = useGroupEvents({
    enabled: isOpen,
  });
  const {
    isBrowserDownloading,
    downloadBrowser,
    loadDownloadedVersions,
    downloadedVersionsMap,
  } = useBrowserDownload();

  const loadReleaseTypes = useCallback(async () => {
    const request = ++versionRequestRef.current;
    setIsLoadingReleaseTypes(true);
    setReleaseTypesError(false);
    try {
      const releases = await invoke<BrowserReleaseTypes>(
        "get_browser_release_types",
        {
          browserStr: "wayfern",
        },
      );
      await loadDownloadedVersions("wayfern");
      if (versionRequestRef.current === request) {
        setReleaseTypes(releases.stable ? { stable: releases.stable } : {});
      }
    } catch (error) {
      console.error("Failed to load Wayfern release types:", error);
      try {
        const downloaded = await loadDownloadedVersions("wayfern");
        if (versionRequestRef.current === request) {
          setReleaseTypes(downloaded.length ? { stable: downloaded[0] } : {});
          setReleaseTypesError(downloaded.length === 0);
        }
      } catch (error) {
        console.error("Failed to load downloaded Wayfern versions:", error);
        if (versionRequestRef.current === request) setReleaseTypesError(true);
      }
    } finally {
      if (versionRequestRef.current === request)
        setIsLoadingReleaseTypes(false);
    }
  }, [loadDownloadedVersions]);

  useEffect(() => {
    if (isOpen) setDestinationGroupId(groupFromFilter(selectedGroupId));
  }, [isOpen, selectedGroupId]);

  useEffect(() => {
    if (!isOpen) return;
    void loadReleaseTypes();
    void invoke<{ id: string; name: string; extension_ids: string[] }[]>(
      "list_extension_groups",
    )
      .then(setExtensionGroups)
      .catch(() => setExtensionGroups([]));
    void invoke<boolean>("is_geoip_database_available")
      .then(async (available) => {
        if (!available) await invoke("download_geoip_database");
      })
      .catch((error) =>
        console.error("Failed to prepare GeoIP database:", error),
      );
    return () => {
      versionRequestRef.current += 1;
    };
  }, [isOpen, loadReleaseTypes]);

  const downloadedVersions = downloadedVersionsMap.wayfern ?? [];
  const latestVersion = releaseTypes.stable;
  const creatableVersion =
    latestVersion && downloadedVersions.includes(latestVersion)
      ? latestVersion
      : downloadedVersions[0];
  const downloading = isBrowserDownloading("wayfern");
  // Several profiles, or one from a template, go to one batch, which stops at
  // the allowance even where a single profile past it is only a warning.
  const batchRefused =
    allowance !== null &&
    (many || appliedTemplate !== null) &&
    count > allowance.remaining;
  const isCreateDisabled =
    !profileName.trim() ||
    !creatableVersion ||
    downloading ||
    isCreating ||
    hourlyCapReached ||
    closeABrowser ||
    batchRefused ||
    !dnsServerValid;
  const selectedVpn = selectedProxyId?.startsWith("vpn-")
    ? vpnConfigs.find((vpn) => vpn.id === selectedProxyId.slice(4))
    : undefined;
  const selectedProxy = storedProxies.find(
    (proxy) => proxy.id === selectedProxyId,
  );
  const proxyLabel = selectedVpn
    ? `WG — ${selectedVpn.name}`
    : (selectedProxy?.name ?? t("createProfile.proxy.noProxy"));
  const destinationGroup = groups.find(
    (group) => group.id === destinationGroupId,
  );
  // A group deleted since it was picked is no destination; while the list
  // loads, the picked id is kept.
  const groupIdForCreate = destinationGroup
    ? destinationGroup.id
    : isLoadingGroups
      ? destinationGroupId
      : null;
  const hostOs = getCurrentOS();
  const selectedOs = wayfernConfig.os ?? hostOs;
  const crossOs = selectedOs !== hostOs;
  const SelectedOsIcon = getOSIcon(selectedOs);

  const clearPassword = () => {
    setEnablePassword(false);
    setPassword("");
    setPasswordConfirm("");
    setPasswordError(null);
  };

  const handleClose = () => {
    versionRequestRef.current += 1;
    setProfileName("");
    setAdvancedOpen(false);
    setSelectedProxyId(undefined);
    setProxyPopoverOpen(false);
    setMorePopoverOpen(false);
    setOsPopoverOpen(false);
    setShowProxyForm(false);
    setDnsBlocklist("");
    setDnsServer("");
    setStartPages("");
    setLaunchHook("");
    setSelectedExtensionGroupId(undefined);
    setReleaseTypes({});
    setIsLoadingReleaseTypes(false);
    setReleaseTypesError(false);
    setWayfernConfig(defaultWayfernConfig());
    setEphemeral(false);
    setAppliedTemplate(null);
    setCount(1);
    setProgress(null);
    clearPassword();
    onClose();
  };

  /** The form as template settings, over the applied template's own extras. */
  const formSettings = (): TemplateSettings => {
    const base = appliedTemplate?.settings;
    const isVpn = selectedProxyId?.startsWith("vpn-") ?? false;
    const proxyId = isVpn ? null : (selectedProxyId ?? null);
    const spread = base?.proxy_ids ?? [];
    return {
      ...base,
      name_prefix: profileName.trim() || null,
      proxy_id: proxyId,
      vpn_id: isVpn ? (selectedProxyId?.slice(4) ?? null) : null,
      // A template that spreads its profiles over several proxies keeps
      // doing so while its first proxy is still the one chosen.
      proxy_ids: proxyId && spread[0] === proxyId ? spread : [],
      group_id: groupIdForCreate,
      extension_group_id: selectedExtensionGroupId ?? null,
      dns_blocklist: dnsBlocklist || null,
      dns_server: dnsServer.trim() || null,
      start_urls: startPagesFromText(startPages),
      launch_hook: launchHook.trim() || null,
      ephemeral,
      wayfern_config: wayfernConfig,
    };
  };

  const applyTemplate = (template: ProfileTemplate | null) => {
    setAppliedTemplate(template);
    if (!template) return;
    const settings = template.settings;
    setSelectedProxyId(
      settings.vpn_id
        ? `vpn-${settings.vpn_id}`
        : (settings.proxy_ids?.[0] ?? settings.proxy_id ?? undefined),
    );
    setWayfernConfig({
      ...defaultWayfernConfig(),
      ...(settings.wayfern_config ?? {}),
    });
    setDnsBlocklist(settings.dns_blocklist ?? "");
    setDnsServer(settings.dns_server ?? "");
    setStartPages((settings.start_urls ?? []).join("\n"));
    setLaunchHook(settings.launch_hook ?? "");
    setSelectedExtensionGroupId(settings.extension_group_id ?? undefined);
    setEphemeral(settings.ephemeral === true);
    if (settings.group_id) setDestinationGroupId(settings.group_id);
    if (settings.ephemeral) clearPassword();
    if (!profileName.trim()) {
      setProfileName(settings.name_prefix ?? template.name);
    }
  };

  const saveTemplate = async (name: string) => {
    const existing = templates.find(
      (template) => template.name.toLowerCase() === name.toLowerCase(),
    );
    try {
      const saved = existing
        ? await invoke<ProfileTemplate>("update_profile_template", {
            templateId: existing.id,
            name,
            settings: formSettings(),
          })
        : await invoke<ProfileTemplate>("create_profile_template", {
            name,
            settings: formSettings(),
          });
      setAppliedTemplate(saved);
      showSuccessToast(t("templates.saved", { name: saved.name }));
      return true;
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
      return false;
    }
  };

  const afterTemplatesRemoved = (ids: string[]) => {
    if (appliedTemplate && ids.includes(appliedTemplate.id)) {
      setAppliedTemplate(null);
    }
  };

  // A template goes to the trash at once and the toast offers Undo. Only
  // "Delete at once" asks first, inline in the picker.
  const deleteTemplate = async (
    template: ProfileTemplate,
    confirm: () => void,
  ) => {
    afterTemplatesRemoved(await requestTemplateTrash([template], confirm));
  };

  const deleteTemplateNow = async (template: ProfileTemplate) => {
    afterTemplatesRemoved(await removeTemplates([template]));
  };

  const changeCount = (next: number) => {
    setCount(next);
    if (next > 1) clearPassword();
  };

  /** Several profiles, or one from a template: one backend run for both. */
  const createFromSettings = async () => {
    setIsCreating(true);
    setProgress({ done: 0, total: count });
    const stopListening = await listen<{ done: number; total: number }>(
      "profiles-bulk-create-progress",
      (event) => setProgress(event.payload),
    );
    try {
      const result = await invoke<BulkCreateResult>("bulk_create_profiles", {
        settings: formSettings(),
        name: profileName.trim(),
        count,
      });
      const [first] = result.created;
      if (count === 1 && first && enablePassword && !ephemeral) {
        try {
          await invoke("set_profile_password", {
            profileId: first.id,
            password,
          });
        } catch (error) {
          showErrorToast(
            t("errors.setProfilePasswordFailed", {
              error: translateBackendError(t, error),
            }),
          );
        }
      }
      const outcome = result.error
        ? t("templates.stoppedEarly", {
            created: result.created.length,
            total: count,
            error: translateBackendError(t, result.error),
          })
        : t("templates.created", { count: result.created.length });
      if (result.error) showErrorToast(outcome);
      else showSuccessToast(outcome);
      if (count > 1) {
        void notifySystem({ title: t("templates.notifyTitle"), body: outcome });
      }
      handleClose();
    } catch (error) {
      showErrorToast(
        t("errors.createProfileFailed", {
          error: translateBackendError(t, error),
        }),
      );
      void loadAllowance();
    } finally {
      stopListening();
      setIsCreating(false);
      setProgress(null);
    }
  };

  const handleCreate = async () => {
    if (isCreateDisabled || !creatableVersion) return;
    if (enablePassword && !ephemeral) {
      if (password.length < PASSWORD_MIN_LEN) {
        setPasswordError(
          t("profilePassword.errors.tooShort", { min: PASSWORD_MIN_LEN }),
        );
        return;
      }
      if (password !== passwordConfirm) {
        setPasswordError(t("profilePassword.errors.mismatch"));
        return;
      }
    }
    setPasswordError(null);
    if (many || appliedTemplate) {
      await createFromSettings();
      return;
    }
    setIsCreating(true);
    const isVpnSelection = selectedProxyId?.startsWith("vpn-") ?? false;
    try {
      await onCreateProfile({
        name: profileName.trim(),
        browserStr: "wayfern",
        version: creatableVersion,
        releaseType: "stable",
        proxyId: isVpnSelection ? undefined : selectedProxyId,
        vpnId: isVpnSelection ? selectedProxyId?.slice(4) : undefined,
        wayfernConfig,
        groupId: groupIdForCreate,
        extensionGroupId: selectedExtensionGroupId,
        ephemeral,
        dnsBlocklist: dnsBlocklist || undefined,
        dnsServer: dnsServer.trim() || undefined,
        startUrls: startPagesFromText(startPages),
        launchHook: launchHook.trim() || undefined,
        password: enablePassword && !ephemeral ? password : undefined,
      });
      handleClose();
    } catch (error) {
      console.error("Failed to create profile:", error);
      void loadAllowance();
    } finally {
      setIsCreating(false);
    }
  };

  const handleDownload = async () => {
    if (!latestVersion) return;
    try {
      await downloadBrowser("wayfern", latestVersion);
    } catch (error) {
      console.error("Failed to download Wayfern:", error);
    }
  };

  const updateWayfernConfig = useCallback(
    (key: keyof WayfernConfig, value: unknown) => {
      setWayfernConfig((previous) => ({ ...previous, [key]: value }));
    },
    [],
  );

  const animateEntry = motionAllowed;
  const rise = (delay: number) =>
    animateEntry
      ? {
          initial: { y: 6 },
          animate: { y: 0 },
          transition: { ...MOTION_SPRING.page, delay },
        }
      : {};
  const countHint: CountHintLine[] = [];
  if (many) {
    countHint.push({
      text: t("templates.namesHint", {
        name: profileName.trim() || t("createProfile.profileName"),
      }),
    });
  }
  if (allowance !== null && allowance.remaining > 0) {
    countHint.push({
      text: t("templates.allowanceLeft", { count: allowance.remaining }),
      limit: maxCount < MAX_BULK_CREATE,
    });
  }
  if (maxCount === MAX_BULK_CREATE) {
    countHint.push({
      text: t("backendErrors.bulkCreateCountInvalid", {
        max: MAX_BULK_CREATE,
      }),
      limit: true,
      atLimitOnly: true,
    });
  }

  const reveal = animateEntry
    ? {
        initial: { y: -6, scale: 0.985 },
        animate: { y: 0, scale: 1 },
        transition: MOTION_SPRING.page,
      }
    : {};

  const createButton = (
    <LoadingButton
      data-slot="profile-create-submit"
      onClick={handleCreate}
      isLoading={isCreating}
      disabled={isCreateDisabled}
      className="h-9 rounded-md px-4 transition-[opacity,box-shadow,transform] duration-200"
    >
      {t("common.buttons.create")}
    </LoadingButton>
  );

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !isCreating) handleClose();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-max(1.5rem,12vh)-1.5rem)] max-w-lg flex-col gap-4 overflow-hidden rounded-2xl border-0 p-5 shadow-2xl ring-1 ring-foreground/10"
        // Anchored near the top rather than centered, so options that open
        // below push the footer down instead of moving the whole dialog.
        style={
          {
            top: "max(1.5rem, 12vh)",
            "--tw-translate-y": "0px",
          } as React.CSSProperties
        }
        aria-describedby={undefined}
        dismissible={!isCreating}
        hideClose
      >
        <DialogHeader className="shrink-0 flex-row items-center justify-between gap-2 space-y-0 pr-0">
          <DialogTitle className="text-base">
            {t("createProfile.title")}
          </DialogTitle>
          <div className="flex shrink-0 items-center gap-1.5">
            <TemplatePicker
              templates={templates}
              applied={appliedTemplate}
              onApply={applyTemplate}
              onSave={saveTemplate}
              onDelete={deleteTemplate}
              onDeleteNow={deleteTemplateNow}
              disabled={isCreating}
              animate={animateEntry}
            />
            <DialogClose
              data-slot="profile-create-close"
              aria-label={t("common.buttons.close")}
              className={cn(optionPill(false), "size-7 justify-center px-0")}
              disabled={isCreating}
            >
              <LuX />
            </DialogClose>
          </div>
        </DialogHeader>

        <div
          data-slot="profile-create-fields"
          className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1 pt-1 pb-2"
        >
          <motion.div
            data-slot="profile-name-field"
            className="flex items-center gap-2 rounded-xl bg-foreground/4 p-2 transition-[background-color,box-shadow] duration-150 focus-within:bg-foreground/6 focus-within:ring-2 focus-within:ring-foreground/10 hover:bg-foreground/5"
            {...rise(0)}
          >
            <label
              htmlFor="profile-name"
              className="flex min-w-0 flex-1 cursor-text items-center gap-2.5"
            >
              <ProfileGlyph
                seed={profileName}
                routed={!!selectedProxyId}
                locked={enablePassword}
                ephemeral={ephemeral}
                busy={isCreating}
              />
              <span className="sr-only">{t("createProfile.profileName")}</span>
              <Input
                id="profile-name"
                variant="bare"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void handleCreate();
                  }
                }}
                placeholder={t("createProfile.profileNamePlaceholder")}
                disabled={isCreating}
                className="h-9 text-base font-medium md:text-base"
              />
            </label>
            <span id={osLabelId} className="sr-only">
              {t("fingerprint.osLabel")}
            </span>
            <Popover open={osPopoverOpen} onOpenChange={setOsPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  id="profile-os"
                  type="button"
                  role="combobox"
                  aria-expanded={osPopoverOpen}
                  aria-controls={osListboxId}
                  aria-labelledby={`${osLabelId} ${osValueId}`}
                  className={cn(optionPill(crossOs), "shrink-0")}
                  disabled={isCreating}
                >
                  <PillIcon on={crossOs} animate={animateEntry}>
                    <SelectedOsIcon />
                  </PillIcon>
                  <PillLabel
                    id={osValueId}
                    label={getOSDisplayName(selectedOs)}
                    animate={animateEntry}
                  />
                  <LuChevronDown
                    className={cn(
                      "-mr-0.5 opacity-60 transition-transform duration-200 motion-reduce:transition-none",
                      osPopoverOpen && "rotate-180",
                    )}
                    aria-hidden="true"
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-52 p-0" align="end" sideOffset={6}>
                <Command>
                  <CommandList id={osListboxId}>
                    <CommandGroup>
                      {OS_OPTIONS.map((os) => {
                        const locked = os !== hostOs && !crossOsUnlocked;
                        const Icon = getOSIcon(os);
                        return (
                          <CommandItem
                            key={os}
                            value={os}
                            disabled={locked}
                            onSelect={() => {
                              updateWayfernConfig("os", os);
                              setOsPopoverOpen(false);
                            }}
                          >
                            <LuCheck
                              className={cn(
                                "size-4 shrink-0",
                                selectedOs === os ? "opacity-100" : "opacity-0",
                              )}
                              aria-hidden="true"
                            />
                            <Icon
                              className="size-3.5 shrink-0"
                              aria-hidden="true"
                            />
                            <span className="truncate">
                              {getOSDisplayName(os)}
                            </span>
                            {locked && <ProBadge className="ml-auto" />}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </motion.div>

          <motion.div className="flex items-center gap-1.5" {...rise(0.04)}>
            <span id={proxyLabelId} className="sr-only">
              {t("createProfile.proxy.title")}
            </span>
            <Popover open={proxyPopoverOpen} onOpenChange={setProxyPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  id="profile-proxy"
                  type="button"
                  role="combobox"
                  aria-expanded={proxyPopoverOpen}
                  aria-controls={proxyListboxId}
                  aria-labelledby={`${proxyLabelId} ${proxyValueId}`}
                  className={cn(
                    optionPill(!!selectedProxyId),
                    "grow justify-center",
                  )}
                  disabled={isCreating}
                >
                  <PillIcon on={!!selectedProxyId} animate={animateEntry}>
                    {selectedVpn ? <LuShieldCheck /> : <LuGlobe />}
                  </PillIcon>
                  <PillLabel
                    id={proxyValueId}
                    label={proxyLabel}
                    animate={animateEntry}
                  />
                  <LuChevronDown
                    className={cn(
                      "-mr-0.5 opacity-60 transition-transform duration-200 motion-reduce:transition-none",
                      proxyPopoverOpen && "rotate-180",
                    )}
                    aria-hidden="true"
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-0" align="start" sideOffset={6}>
                <Command>
                  <CommandInput placeholder={t("createProfile.proxy.search")} />
                  <CommandList id={proxyListboxId}>
                    <CommandEmpty>
                      {t("createProfile.proxy.notFound")}
                    </CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        value="__none__"
                        keywords={[
                          t("common.labels.none"),
                          t("createProfile.proxy.noProxy"),
                        ]}
                        onSelect={() => {
                          setSelectedProxyId(undefined);
                          setProxyPopoverOpen(false);
                        }}
                      >
                        <LuCheck
                          className={cn(
                            "size-4 shrink-0",
                            !selectedProxyId ? "opacity-100" : "opacity-0",
                          )}
                          aria-hidden="true"
                        />
                        {t("common.labels.none")}
                      </CommandItem>
                      {storedProxies.map((proxy) => (
                        <CommandItem
                          key={proxy.id}
                          value={proxy.id}
                          keywords={[proxy.name]}
                          onSelect={() => {
                            setSelectedProxyId(proxy.id);
                            setProxyPopoverOpen(false);
                          }}
                        >
                          <LuCheck
                            className={cn(
                              "size-4 shrink-0",
                              selectedProxyId === proxy.id
                                ? "opacity-100"
                                : "opacity-0",
                            )}
                            aria-hidden="true"
                          />
                          <span className="truncate">{proxy.name}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                    {vpnConfigs.length > 0 && (
                      <CommandGroup heading={t("proxies.management.tabVpns")}>
                        {vpnConfigs.map((vpn) => (
                          <CommandItem
                            key={vpn.id}
                            value={`vpn-${vpn.id}`}
                            keywords={[vpn.name, "VPN", "WireGuard"]}
                            onSelect={() => {
                              setSelectedProxyId(`vpn-${vpn.id}`);
                              setProxyPopoverOpen(false);
                            }}
                          >
                            <LuCheck
                              className={cn(
                                "size-4 shrink-0",
                                selectedProxyId === `vpn-${vpn.id}`
                                  ? "opacity-100"
                                  : "opacity-0",
                              )}
                              aria-hidden="true"
                            />
                            <Badge
                              variant="soft"
                              className="px-1 py-0 text-[11px] leading-tight"
                            >
                              WG
                            </Badge>
                            <span className="truncate">{vpn.name}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                    <CommandSeparator
                      alwaysRender
                      className="my-1 bg-foreground/8"
                    />
                    <CommandGroup forceMount>
                      <CommandItem
                        value="__add_proxy__"
                        forceMount
                        onSelect={() => {
                          setProxyPopoverOpen(false);
                          setShowProxyForm(true);
                        }}
                      >
                        <LuPlus
                          className="size-4 shrink-0"
                          aria-hidden="true"
                        />
                        {t("createProfile.proxy.addProxy")}
                      </CommandItem>
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            <OptionToggle
              id="enable-password"
              checked={enablePassword}
              onCheckedChange={(checked) => {
                if (checked) {
                  setEnablePassword(true);
                  setEphemeral(false);
                } else clearPassword();
              }}
              disabled={isCreating || many}
              animate={animateEntry}
              icon={enablePassword ? <LuLock /> : <LuLockOpen />}
              label={t("profilePassword.fields.password")}
              hint={
                many
                  ? t("templates.passwordOneOnly")
                  : t("createProfile.passwordProtect.description")
              }
            />
            <OptionToggle
              id="ephemeral"
              checked={ephemeral}
              onCheckedChange={(checked) => {
                setEphemeral(checked);
                if (checked) clearPassword();
              }}
              disabled={isCreating}
              animate={animateEntry}
              icon={<LuFlame className={cn(ephemeral && "fill-current")} />}
              label={t("profiles.ephemeral")}
              hint={t("profiles.ephemeralDescription")}
            />
            <Popover open={morePopoverOpen} onOpenChange={setMorePopoverOpen}>
              <Tooltip delayDuration={600}>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button
                      id="profile-more-options"
                      type="button"
                      data-slot="profile-create-more"
                      aria-label={t("createProfile.moreOptions")}
                      aria-haspopup="dialog"
                      aria-expanded={morePopoverOpen}
                      aria-describedby={
                        destinationGroup ? groupValueId : undefined
                      }
                      className={cn(
                        optionPill(!!destinationGroup),
                        "w-8 shrink-0 justify-center px-0",
                      )}
                      disabled={isCreating}
                    >
                      <PillIcon on={!!destinationGroup} animate={animateEntry}>
                        <LuEllipsis />
                      </PillIcon>
                      {destinationGroup && (
                        <span id={groupValueId} className="sr-only">
                          {destinationGroup.name}
                        </span>
                      )}
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} className="max-w-72">
                  <p>{t("createProfile.moreOptions")}</p>
                  {destinationGroup && (
                    <p className="flex items-center gap-1 opacity-70">
                      <LuFolder
                        className="size-3 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="truncate">{destinationGroup.name}</span>
                    </p>
                  )}
                </TooltipContent>
              </Tooltip>
              <PopoverContent className="w-64 p-0" align="start" sideOffset={6}>
                <Command>
                  {groups.length > 6 && (
                    <CommandInput
                      placeholder={t("commandPalette.pages.group.placeholder")}
                    />
                  )}
                  <CommandList id={groupListboxId}>
                    <CommandEmpty>
                      {t("createProfile.group.notFound")}
                    </CommandEmpty>
                    <CommandGroup heading={t("profiles.table.group")}>
                      <CommandItem
                        value="__no_group__"
                        keywords={[t("groups.noGroup")]}
                        onSelect={() => {
                          setDestinationGroupId(null);
                          setMorePopoverOpen(false);
                        }}
                      >
                        <LuCheck
                          className={cn(
                            "size-4 shrink-0",
                            !destinationGroup ? "opacity-100" : "opacity-0",
                          )}
                          aria-hidden="true"
                        />
                        {t("groups.noGroup")}
                      </CommandItem>
                      {groups.map((group) => (
                        <CommandItem
                          key={group.id}
                          value={group.id}
                          keywords={[group.name]}
                          onSelect={() => {
                            setDestinationGroupId(group.id);
                            setMorePopoverOpen(false);
                          }}
                        >
                          <LuCheck
                            className={cn(
                              "size-4 shrink-0",
                              destinationGroup?.id === group.id
                                ? "opacity-100"
                                : "opacity-0",
                            )}
                            aria-hidden="true"
                          />
                          <LuFolder
                            className="size-3.5 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                          <span className="truncate">{group.name}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </motion.div>

          {(ephemeral || enablePassword) && <EphemeralStorageNotice />}

          {enablePassword && (
            <motion.div className="space-y-1.5" {...reveal}>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <Label htmlFor="profile-password" className="sr-only">
                    {t("profilePassword.fields.newPassword")}
                  </Label>
                  <Input
                    id="profile-password"
                    variant="soft"
                    type="password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setPasswordError(null);
                    }}
                    placeholder={t("profilePassword.fields.newPassword")}
                    autoComplete="new-password"
                    aria-invalid={!!passwordError}
                    aria-describedby={
                      passwordError ? "profile-password-error" : undefined
                    }
                    disabled={isCreating}
                  />
                </div>
                <div>
                  <Label htmlFor="profile-password-confirm" className="sr-only">
                    {t("profilePassword.fields.confirm")}
                  </Label>
                  <Input
                    id="profile-password-confirm"
                    variant="soft"
                    type="password"
                    value={passwordConfirm}
                    onChange={(event) => {
                      setPasswordConfirm(event.target.value);
                      setPasswordError(null);
                    }}
                    placeholder={t("profilePassword.fields.confirm")}
                    autoComplete="new-password"
                    aria-invalid={!!passwordError}
                    aria-describedby={
                      passwordError ? "profile-password-error" : undefined
                    }
                    disabled={isCreating}
                  />
                </div>
              </div>
              {passwordError && (
                <motion.p
                  key={passwordError}
                  id="profile-password-error"
                  role="alert"
                  className="px-1 text-xs text-destructive-text"
                  initial={animateEntry ? { x: 0 } : false}
                  animate={animateEntry ? { x: [0, -4, 4, -2, 0] } : { x: 0 }}
                  transition={{
                    duration: MOTION_DURATION.slow,
                    ease: MOTION_EASE_OUT,
                  }}
                >
                  {passwordError}
                </motion.p>
              )}
            </motion.div>
          )}

          {crossOs && (
            <motion.p
              role="status"
              className={cn(STATUS_CLASS, "items-start")}
              {...reveal}
            >
              <LuTriangleAlert
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
              {t("fingerprint.crossOsWarning")}
            </motion.p>
          )}

          {downloading ? (
            <motion.p role="status" className={STATUS_CLASS} {...reveal}>
              <LuLoaderCircle
                className="size-3.5 shrink-0 animate-spin"
                aria-hidden="true"
              />
              {t("createProfile.version.downloading", {
                browser: "Wayfern",
                version: latestVersion,
              })}
            </motion.p>
          ) : (
            !creatableVersion &&
            (isLoadingReleaseTypes ? (
              <motion.p role="status" className={STATUS_CLASS} {...reveal}>
                <LuLoaderCircle
                  className="size-3.5 shrink-0 animate-spin"
                  aria-hidden="true"
                />
                {t("createProfile.version.fetching")}
              </motion.p>
            ) : releaseTypesError ? (
              <motion.div
                role="alert"
                className={cn(STATUS_CLASS, "bg-destructive/10 py-1.5 pr-1.5")}
                {...reveal}
              >
                <p className="flex-1 text-destructive-text">
                  {t("createProfile.version.fetchError")}
                </p>
                <Button
                  onClick={() => void loadReleaseTypes()}
                  size="sm"
                  variant="soft"
                  className="h-7 rounded-md text-xs"
                >
                  {t("common.buttons.retry")}
                </Button>
              </motion.div>
            ) : latestVersion ? (
              <motion.div
                className={cn(STATUS_CLASS, "py-1.5 pr-1.5")}
                {...reveal}
              >
                <p className="flex-1">
                  {t("createProfile.version.needsDownload", {
                    browser: "Wayfern",
                    version: latestVersion,
                  })}
                </p>
                <Button
                  onClick={() => void handleDownload()}
                  size="sm"
                  className="h-7 rounded-md text-xs"
                >
                  {t("common.buttons.download")}
                </Button>
              </motion.div>
            ) : (
              <p
                role="status"
                className={cn(STATUS_CLASS, "text-warning-text")}
              >
                {t("createProfile.platformUnavailable", {
                  browser: "Wayfern",
                })}
              </p>
            ))
          )}

          {hourlyCapReached && (
            <motion.p
              role="status"
              data-slot="hourly-limit"
              className={cn(STATUS_CLASS, "items-start")}
              {...reveal}
            >
              <LuClock
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
              {t("createProfile.hourlyLimit.reached", {
                limit: allowance.per_hour,
                minutes: Math.max(
                  1,
                  Math.ceil((allowance.retry_after_secs ?? 60) / 60),
                ),
              })}
            </motion.p>
          )}

          {creatingQuickly && (
            <motion.div
              role="status"
              className={cn(
                STATUS_CLASS,
                "items-start bg-warning/10 text-warning-text",
              )}
              {...reveal}
            >
              <LuTriangleAlert
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
              <div className="space-y-0.5">
                <p className="font-medium">
                  {t("createProfile.hourlyLimit.warningTitle")}
                </p>
                <p>{t("createProfile.hourlyLimit.warning")}</p>
              </div>
            </motion.div>
          )}

          <div id={advancedOptionsId} hidden={!advancedOpen}>
            <AnimatedDisclosureContent
              open={advancedOpen}
              className="space-y-4 pt-2"
            >
              <SoftFields>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="launch-hook-url"
                      className={FIELD_LABEL_CLASS}
                    >
                      {t("createProfile.launchHook.label")}
                    </Label>
                    <Input
                      id="launch-hook-url"
                      variant="soft"
                      value={launchHook}
                      onChange={(event) => setLaunchHook(event.target.value)}
                      placeholder={t("createProfile.launchHook.placeholder")}
                      disabled={isCreating}
                    />
                  </div>
                  <div
                    className={cn(
                      "grid gap-4",
                      extensionGroups.length > 0 && "sm:grid-cols-2",
                    )}
                  >
                    <div className="min-w-0 space-y-1.5">
                      <Label
                        htmlFor="profile-dns-blocklist"
                        className={FIELD_LABEL_CLASS}
                      >
                        {t("dnsBlocklist.title")}
                      </Label>
                      <Select
                        value={dnsBlocklist || "none"}
                        onValueChange={(value) =>
                          setDnsBlocklist(value === "none" ? "" : value)
                        }
                        disabled={isCreating}
                      >
                        <SelectTrigger
                          id="profile-dns-blocklist"
                          variant="soft"
                          className="w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">
                            {t("dnsBlocklist.none")}
                          </SelectItem>
                          {DNS_BLOCKLIST_LEVELS.map((level) => (
                            <SelectItem key={level.value} value={level.value}>
                              {t(level.labelKey)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {extensionGroups.length > 0 && (
                      <div className="min-w-0 space-y-1.5">
                        <Label
                          htmlFor="profile-extension-group"
                          className={FIELD_LABEL_CLASS}
                        >
                          {t("extensions.extensionGroup")}
                        </Label>
                        <Select
                          value={selectedExtensionGroupId ?? "none"}
                          onValueChange={(value) =>
                            setSelectedExtensionGroupId(
                              value === "none" ? undefined : value,
                            )
                          }
                          disabled={isCreating}
                        >
                          <SelectTrigger
                            id="profile-extension-group"
                            variant="soft"
                            className="w-full"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">
                              {t("profileInfo.values.none")}
                            </SelectItem>
                            {extensionGroups.map((group) => (
                              <SelectItem key={group.id} value={group.id}>
                                {group.name} ({group.extension_ids.length})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="profile-dns-server"
                      className={FIELD_LABEL_CLASS}
                    >
                      {t("dnsServer.label")}
                    </Label>
                    <DnsServerField
                      id="profile-dns-server"
                      value={dnsServer}
                      onChange={setDnsServer}
                      onValidityChange={setDnsServerValid}
                      disabled={isCreating}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="profile-start-pages"
                      className={FIELD_LABEL_CLASS}
                    >
                      {t("profileInfo.sections.startPages")}
                    </Label>
                    <Textarea
                      id="profile-start-pages"
                      variant="soft"
                      value={startPages}
                      onChange={(event) => setStartPages(event.target.value)}
                      placeholder={t("startPages.placeholder")}
                      rows={3}
                      spellCheck={false}
                      disabled={isCreating}
                      className="font-mono text-xs"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("startPages.description")}
                    </p>
                  </div>
                  <div className="space-y-4 pt-1">
                    {creatableVersion && (
                      <p className="text-xs text-muted-foreground">
                        {t("createProfile.version.available", {
                          browser: "Wayfern",
                          version: creatableVersion,
                        })}
                      </p>
                    )}
                    {creatableVersion &&
                      latestVersion &&
                      !downloadedVersions.includes(latestVersion) &&
                      !downloading && (
                        <div className={cn(STATUS_CLASS, "py-1.5 pr-1.5")}>
                          <p className="flex-1">
                            {t("createProfile.version.upgradeAvailable", {
                              browser: "Wayfern",
                              version: latestVersion,
                            })}
                          </p>
                          <Button
                            onClick={() => void handleDownload()}
                            size="sm"
                            variant="soft"
                            className="h-7 rounded-md text-xs"
                            disabled={isCreating}
                          >
                            {t("common.buttons.download")}
                          </Button>
                        </div>
                      )}
                    <WayfernConfigForm
                      className="[&_[data-slot=select-trigger]]:w-full"
                      config={wayfernConfig}
                      onConfigChange={updateWayfernConfig}
                      isCreating
                      forceAdvanced
                      readOnly={isCreating}
                      crossOsUnlocked={crossOsUnlocked}
                      limitedMode={!crossOsUnlocked}
                      osPicker={false}
                      profileVersion={creatableVersion}
                      profileBrowser="wayfern"
                    />
                  </div>
                </div>
              </SoftFields>
            </AnimatedDisclosureContent>
          </div>
        </div>

        <DialogFooter className="items-center">
          {/* Every control here keeps its size whatever the count, so the
              row never reflows; the batch progress takes the place of
              Advanced options without moving the buttons. */}
          <div className="relative flex min-w-0 grow items-center">
            <Button
              variant="subtle"
              size="sm"
              className={cn(
                "-ml-2 gap-1 rounded-lg px-2",
                progress && "invisible",
              )}
              aria-expanded={advancedOpen}
              aria-controls={advancedOptionsId}
              onClick={() => setAdvancedOpen((open) => !open)}
              disabled={isCreating}
            >
              <AnimatedDisclosureChevron open={advancedOpen}>
                <LuChevronRight className="size-4" />
              </AnimatedDisclosureChevron>
              {t("createProfile.advancedOptions")}
            </Button>
            <p
              role="status"
              data-slot="profile-create-progress"
              className="pointer-events-none absolute inset-0 flex min-w-0 items-center gap-2 text-xs text-muted-foreground tabular-nums"
            >
              {progress && (
                <>
                  <span
                    aria-hidden="true"
                    className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-foreground/10"
                  >
                    <motion.span
                      className="block h-full rounded-full bg-foreground"
                      style={{ originX: 0 }}
                      initial={false}
                      animate={{
                        scaleX: progress.total
                          ? progress.done / progress.total
                          : 0,
                      }}
                      transition={{
                        duration: animateEntry ? MOTION_DURATION.slow : 0,
                        ease: MOTION_EASE_OUT,
                      }}
                    />
                  </span>
                  <span className="truncate">
                    {t("templates.progress", progress)}
                  </span>
                </>
              )}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="subtle"
              data-slot={progress ? "profile-create-stop" : undefined}
              onClick={
                progress
                  ? () => void invoke("cancel_bulk_create_profiles")
                  : handleClose
              }
              disabled={isCreating && !progress}
            >
              <SwapLabel
                labels={[t("common.buttons.cancel"), t("templates.stop")]}
                shown={progress ? 1 : 0}
              />
            </Button>
            <CountStepper
              value={count}
              max={maxCount}
              onChange={changeCount}
              disabled={isCreating}
              hint={countHint}
            />
            {closeABrowser ? (
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <span
                    data-slot="profile-create-close-a-browser"
                    // A disabled button takes no pointer events, so the
                    // reason lives on its wrapper.
                    className="inline-flex rounded-md"
                  >
                    {createButton}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} className="max-w-72">
                  {t("backendErrors.tooManyBrowsersRunning")}
                </TooltipContent>
              </Tooltip>
            ) : (
              createButton
            )}
          </div>
        </DialogFooter>
      </DialogContent>
      <ProxyFormDialog
        isOpen={showProxyForm}
        onClose={() => setShowProxyForm(false)}
      />
    </Dialog>
  );
}

/** The group a list filter names, or none for "All". */
function groupFromFilter(filter: string | undefined): string | null {
  return filter && filter !== "__all__" ? filter : null;
}

/** Mirror of `profile_generation_limiter::Allowance`. */
interface ProfileCreationAllowance {
  enforcement: "hard" | "soft";
  per_hour: number;
  used: number;
  retry_after_secs: number | null;
  remaining: number;
  close_a_browser: boolean;
}

const STATUS_CLASS =
  "flex items-center gap-2 rounded-lg bg-foreground/4 px-3 py-2 text-xs text-muted-foreground";

const FIELD_LABEL_CLASS = "text-xs font-medium text-muted-foreground";

function optionPill(on: boolean) {
  return cn(
    "inline-flex h-8 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm font-medium select-none transition-[background-color,color,box-shadow,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100 [&_svg]:size-3.5 [&_svg]:shrink-0",
    FOCUS_RING,
    on
      ? "bg-primary/10 text-foreground [&_svg]:text-primary-text"
      : "bg-foreground/5 text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
  );
}

/**
 * False on the first render, true after it. A pill's parts spring when their
 * option changes, never as the dialog opens: the first frame shows every
 * option at rest, so a stalled frame cannot leave one half drawn.
 */
function useMounted() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return mounted.current;
}

/** A pill's icon springs in whenever the option it marks changes state. */
function PillIcon({
  on,
  animate,
  children,
}: {
  on: boolean;
  animate: boolean;
  children: React.ReactNode;
}) {
  const mounted = useMounted();
  return (
    <motion.span
      key={String(on)}
      aria-hidden="true"
      className="inline-flex"
      initial={
        animate && mounted ? { scale: 0.4, rotate: on ? -24 : 24 } : false
      }
      animate={{ scale: 1, rotate: 0 }}
      transition={MOTION_SPRING.snappy}
    >
      {children}
    </motion.span>
  );
}

/** The chosen route's name, which rises into place when it changes. */
function PillLabel({
  id,
  label,
  animate,
}: {
  id: string;
  label: string;
  animate: boolean;
}) {
  const mounted = useMounted();
  return (
    <motion.span
      key={label}
      id={id}
      className="min-w-0 truncate"
      initial={animate && mounted ? { y: 4 } : false}
      animate={{ y: 0 }}
      transition={MOTION_SPRING.page}
    >
      {label}
    </motion.span>
  );
}

/**
 * An on/off option drawn as a pill. It is a real checkbox underneath, so it
 * keeps the checkbox role, state and keyboard behavior; the hint explains the
 * option without adding text to the form.
 */
function OptionToggle({
  id,
  checked,
  onCheckedChange,
  disabled,
  animate,
  icon,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled: boolean;
  animate: boolean;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <Tooltip delayDuration={600}>
      <TooltipTrigger asChild>
        <CheckboxPrimitive.Root
          id={id}
          checked={checked}
          onCheckedChange={(state) => onCheckedChange(state === true)}
          disabled={disabled}
          className={cn(optionPill(checked), "grow shrink-0 justify-center")}
        >
          <PillIcon on={checked} animate={animate}>
            {icon}
          </PillIcon>
          <span className="truncate">{label}</span>
        </CheckboxPrimitive.Root>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-72">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

/** Picks a template for the form, saves the form as one, or deletes one. */
function TemplatePicker({
  templates,
  applied,
  onApply,
  onSave,
  onDelete,
  onDeleteNow,
  disabled,
  animate,
}: {
  templates: ProfileTemplate[];
  applied: ProfileTemplate | null;
  onApply: (template: ProfileTemplate | null) => void;
  onSave: (name: string) => Promise<boolean>;
  /** Moves it to the trash; calls `confirm` instead when the trash is off. */
  onDelete: (template: ProfileTemplate, confirm: () => void) => Promise<void>;
  /** Deletes it after the inline confirmation. */
  onDeleteNow: (template: ProfileTemplate) => Promise<void>;
  disabled: boolean;
  animate: boolean;
}) {
  const { t } = useTranslation();
  const valueId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const trimmed = name.trim();
  const replaces = templates.some(
    (template) => template.name.toLowerCase() === trimmed.toLowerCase(),
  );

  useEffect(() => {
    if (!open) return;
    setName(applied?.name ?? "");
    setConfirmingDelete(null);
  }, [open, applied]);

  const save = async () => {
    if (!trimmed || saving) return;
    setSaving(true);
    const saved = await onSave(trimmed);
    setSaving(false);
    if (saved) setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="template-picker"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-describedby={valueId}
          className={cn(optionPill(applied !== null), "h-7 shrink-0 text-xs")}
          disabled={disabled}
        >
          <PillIcon on={applied !== null} animate={animate}>
            <LuLayoutTemplate />
          </PillIcon>
          <PillLabel
            id={valueId}
            label={applied?.name ?? t("templates.label")}
            animate={animate}
          />
          <LuChevronDown
            className={cn(
              "-mr-0.5 opacity-60 transition-transform duration-200 motion-reduce:transition-none",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end" sideOffset={6}>
        {templates.length > 0 ? (
          <Command>
            <CommandList>
              <CommandGroup>
                {applied && (
                  <CommandItem
                    value="__no_template__"
                    onSelect={() => {
                      onApply(null);
                      setOpen(false);
                    }}
                  >
                    <span className="size-4 shrink-0" aria-hidden="true" />
                    <span className="truncate text-muted-foreground">
                      {t("templates.none")}
                    </span>
                  </CommandItem>
                )}
                {templates.map((template) => (
                  <CommandItem
                    key={template.id}
                    value={template.id}
                    data-slot="template-option"
                    className="group/template"
                    onSelect={() => {
                      onApply(template);
                      setOpen(false);
                    }}
                  >
                    <LuCheck
                      className={cn(
                        "size-4 shrink-0",
                        applied?.id === template.id
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {template.name}
                    </span>
                    {confirmingDelete === template.id ? (
                      <button
                        type="button"
                        data-slot="template-delete-confirm"
                        className="rounded-md px-1.5 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10"
                        onClick={(event) => {
                          event.stopPropagation();
                          setConfirmingDelete(null);
                          void onDeleteNow(template);
                        }}
                      >
                        {t("common.buttons.delete")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-slot="template-delete"
                        aria-label={t("templates.delete", {
                          name: template.name,
                        })}
                        className={cn(
                          "grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-100 group-hover/template:opacity-100 group-data-[selected=true]/template:opacity-100 hover:bg-foreground/8 hover:text-destructive focus-visible:opacity-100 [&_svg]:size-3.5",
                          FOCUS_RING,
                        )}
                        onClick={(event) => {
                          event.stopPropagation();
                          void onDelete(template, () =>
                            setConfirmingDelete(template.id),
                          );
                        }}
                      >
                        <LuTrash2 aria-hidden="true" />
                      </button>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        ) : (
          <p className="px-3 pt-3 text-xs text-muted-foreground">
            {t("templates.empty")}
          </p>
        )}
        <div className="space-y-1.5 p-2">
          <p className={cn(FIELD_LABEL_CLASS, "px-1")}>
            {t("templates.saveCurrent")}
          </p>
          <div className="flex items-center gap-1.5">
            <Input
              variant="soft"
              data-slot="template-name"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void save();
                }
              }}
              placeholder={t("templates.namePlaceholder")}
              aria-label={t("templates.namePlaceholder")}
              className="h-8 text-sm"
            />
            <Button
              size="sm"
              data-slot="template-save"
              className="h-8 shrink-0"
              disabled={!trimmed || saving}
              onClick={() => void save()}
            >
              {replaces ? t("templates.replace") : t("templates.save")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One line of the count stepper's tooltip. */
interface CountHintLine {
  text: string;
  /** Says what bounds the count; stressed once the count is at the bound. */
  limit?: boolean;
  /** Shown only at the bound. */
  atLimitOnly?: boolean;
}

/** Shows one label in the width of the widest, so swapping them moves nothing. */
function SwapLabel({ labels, shown }: { labels: string[]; shown: number }) {
  return (
    <span className="inline-grid">
      {labels.map((label, index) => (
        <span
          key={label}
          aria-hidden={index !== shown}
          className={cn(
            "col-start-1 row-start-1",
            index !== shown && "invisible",
          )}
        >
          {label}
        </span>
      ))}
    </span>
  );
}

/**
 * How many profiles to create, from 1 to `max`. Its width never changes, and
 * what the count means (the names, the allowance, the bound) shows in a
 * tooltip while the pointer or focus is on it, so nothing around it moves.
 */
function CountStepper({
  value,
  max,
  onChange,
  disabled,
  hint,
}: {
  value: number;
  max: number;
  onChange: (value: number) => void;
  disabled: boolean;
  hint: CountHintLine[];
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(String(value));
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const atLimit = value >= max;
  const lines = hint.filter((line) => atLimit || !line.atLimitOnly);
  const open =
    !disabled && !dismissed && (hovered || focused) && lines.length > 0;

  const set = (next: number) => {
    const clamped = Math.min(max, Math.max(1, next));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
    return clamped;
  };
  const stepBy = (delta: number, button: HTMLButtonElement) => {
    const next = set(value + delta);
    // The button disables at either end; the focus it held stays in the stepper.
    if ((next >= max || next <= 1) && document.activeElement === button) {
      inputRef.current?.focus();
    }
  };
  const step = `grid h-9 w-7 place-items-center rounded-md text-muted-foreground transition-colors duration-100 hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5 ${FOCUS_RING}`;

  return (
    <Tooltip open={open}>
      <TooltipTrigger asChild>
        <div
          role="group"
          aria-label={t("templates.count")}
          data-slot="profile-count-stepper"
          className="inline-flex h-9 shrink-0 items-center rounded-md bg-foreground/5"
          onPointerEnter={() => {
            setHovered(true);
            setDismissed(false);
          }}
          onPointerLeave={() => setHovered(false)}
          onFocus={(event) => {
            // A click focuses a button without showing it; only a focus the
            // person sees keeps the tooltip up once the pointer has left.
            setFocused(event.target.matches(":focus-visible"));
            setDismissed(false);
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setFocused(false);
            }
          }}
        >
          <button
            type="button"
            aria-label={t("templates.fewer")}
            data-slot="profile-count-fewer"
            className={step}
            disabled={disabled || value <= 1}
            onClick={(event) => stepBy(-1, event.currentTarget)}
          >
            <LuMinus aria-hidden="true" />
          </button>
          <input
            ref={inputRef}
            id="profile-count"
            data-slot="profile-count"
            inputMode="numeric"
            aria-label={t("templates.count")}
            aria-describedby={lines.length > 0 ? hintId : undefined}
            value={draft}
            disabled={disabled}
            onChange={(event) => {
              const digits = event.target.value.replace(/\D/g, "");
              if (digits) set(Number.parseInt(digits, 10));
              else setDraft("");
            }}
            onBlur={() => {
              if (!draft) setDraft(String(value));
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                set(value + (event.key === "ArrowUp" ? 1 : -1));
              }
            }}
            className="w-8 bg-transparent text-center text-sm tabular-nums outline-none disabled:opacity-50"
          />
          <button
            type="button"
            aria-label={t("templates.more")}
            data-slot="profile-count-more"
            className={step}
            disabled={disabled || atLimit}
            onClick={(event) => stepBy(1, event.currentTarget)}
          >
            <LuPlus aria-hidden="true" />
          </button>
          <span id={hintId} className="sr-only">
            {lines.map((line) => line.text).join(" ")}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={6}
        data-slot="profile-count-hint"
        className="max-w-64 space-y-1"
        onEscapeKeyDown={() => setDismissed(true)}
      >
        {lines.map((line) => (
          <p
            key={line.text}
            data-limit={line.limit && atLimit ? "" : undefined}
            className={cn(line.limit && atLimit && "font-medium")}
          >
            {line.text}
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
