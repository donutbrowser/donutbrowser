"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrent } from "@tauri-apps/plugin-deep-link";
import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AboutDialog } from "@/components/about-dialog";
import { AccountPage } from "@/components/account-page";
import { AgentPage, type AgentTab } from "@/components/agent-page";
import { CloneProfileDialog } from "@/components/clone-profile-dialog";
import { CloseConfirmDialog } from "@/components/close-confirm-dialog";
import { CommandPalette } from "@/components/command-palette";
import { CommercialTrialModal } from "@/components/commercial-trial-modal";
import { CookieBotPage, type CookieBotTab } from "@/components/cookie-bot-page";
import { CookieCopyDialog } from "@/components/cookie-copy-dialog";
import { CookieManagementDialog } from "@/components/cookie-management-dialog";
import { CreateProfileDialog } from "@/components/create-profile-dialog";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { DeviceCodeVerifyDialog } from "@/components/device-code-verify-dialog";
import { ExtensionGroupAssignmentDialog } from "@/components/extension-group-assignment-dialog";
import { ExtensionManagementDialog } from "@/components/extension-management-dialog";
import { FeedbackDialog } from "@/components/feedback-dialog";
import { GroupAssignmentDialog } from "@/components/group-assignment-dialog";
import { GroupManagementDialog } from "@/components/group-management-dialog";
import HomeHeader from "@/components/home-header";
import { ImportProfileDialog } from "@/components/import-profile-dialog";
import { IntegrationsDialog } from "@/components/integrations-dialog";
import { LeavePromptDialog } from "@/components/leave-prompt-dialog";
import { MoveProfilesDialog } from "@/components/move-profiles-dialog";
import { OnboardingTour, type TourStep } from "@/components/onboarding-tour";
import { PageTransition } from "@/components/page-transition";
import { PaidWelcomeDialog } from "@/components/paid-welcome-dialog";
import { PermissionDialog } from "@/components/permission-dialog";
import {
  type GateDecision,
  type GateFindings,
  PreLaunchGateDialog,
} from "@/components/pre-launch-gate-dialog";
import { ProfilesDataTable } from "@/components/profile-data-table";
import { ProfileGroupDragProvider } from "@/components/profile-group-drag";
import {
  type PasswordDialogMode,
  ProfilePasswordDialog,
} from "@/components/profile-password-dialog";
import { ProfileSelectorDialog } from "@/components/profile-selector-dialog";
import { ProfileSyncDialog } from "@/components/profile-sync-dialog";
import { ProxyAssignmentDialog } from "@/components/proxy-assignment-dialog";
import { ProxyDistributionDialog } from "@/components/proxy-distribution-dialog";
import { ProxyManagementDialog } from "@/components/proxy-management-dialog";
import { type AppPage, pageDirection, RailNav } from "@/components/rail-nav";
import { SettingsDialog } from "@/components/settings-dialog";
import { ShortcutsPage } from "@/components/shortcuts-page";
import { SyncAllDialog } from "@/components/sync-all-dialog";
import { SyncConfigDialog } from "@/components/sync-config-dialog";
import { SyncFollowerDialog } from "@/components/sync-follower-dialog";
import { SynchronizerPanel } from "@/components/synchronizer-panel";
import { TableFilterControls } from "@/components/table-controls";
import { ThankYouDialog } from "@/components/thank-you-dialog";
import { TipCoachMark } from "@/components/tips/tip-coach-mark";
import { TipsDialog } from "@/components/tips-dialog";
import { TotpToolDialog } from "@/components/totp-code";
import { TrashPage } from "@/components/trash-page";
import { AutoHeight } from "@/components/ui/auto-height";
import { WayfernConfigDialog } from "@/components/wayfern-config-dialog";
import { WayfernTermsDialog } from "@/components/wayfern-terms-dialog";
import { WelcomeDialog } from "@/components/welcome-dialog";
import { WindowResizeWarningDialog } from "@/components/window-resize-warning-dialog";
import { useAgentConsole } from "@/hooks/use-agent-console";
import { useAppUpdateNotifications } from "@/hooks/use-app-update-notifications";
import { useCloudAuth } from "@/hooks/use-cloud-auth";
import { useCommercialTrial } from "@/hooks/use-commercial-trial";
import { cookieBotScopeFor, useCookieBot } from "@/hooks/use-cookie-bot";
import { useGroupEvents } from "@/hooks/use-group-events";
import { useKonamiCode } from "@/hooks/use-konami-code";
import { useDocumentLanguage } from "@/hooks/use-language";
import { useLaunchNotices } from "@/hooks/use-launch-notices";
import type { PermissionType } from "@/hooks/use-permissions";
import { usePermissions } from "@/hooks/use-permissions";
import { useProfileEvents } from "@/hooks/use-profile-events";
import { useProfileStatuses } from "@/hooks/use-profile-statuses";
import { useProfileTableFilters } from "@/hooks/use-profile-table-filters";
import { useProxyEvents } from "@/hooks/use-proxy-events";
import { useSyncSessions } from "@/hooks/use-sync-session";
import { useTips } from "@/hooks/use-tips";
import { confirmLeave, hasUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useUpdateNotifications } from "@/hooks/use-update-notifications";
import { useVersionUpdater } from "@/hooks/use-version-updater";
import { useVpnEvents } from "@/hooks/use-vpn-events";
import { useWayfernTerms } from "@/hooks/use-wayfern-terms";
import { parseBackendError, translateBackendError } from "@/lib/backend-errors";
import { fireSprinkleConfetti } from "@/lib/confetti";
import {
  canUseCookieBot,
  canUseRemoteControl,
  getEntitlements,
  isTeamLauncher,
} from "@/lib/entitlements";
import { setOnboardingActive } from "@/lib/onboarding-signal";
import { type ProfileSearchContext } from "@/lib/profile-search";
import { startRemoteSession } from "@/lib/remote-sessions";
import {
  matchesGroupDigit,
  matchesShortcut,
  SHORTCUTS,
  type ShortcutId,
} from "@/lib/shortcuts";
import { notifySystem } from "@/lib/system-notify";
import type { TipAction } from "@/lib/tips";
import {
  dismissToast,
  showErrorToast,
  showSuccessToast,
  showSyncProgressToast,
  showToast,
  showUndoToast,
} from "@/lib/toast-utils";
import { playUiSound } from "@/lib/ui-sounds";
import type {
  BrowserProfile,
  ConsistencyResult,
  ExtensionGroup,
  PreLaunchChecks,
  SyncSettings,
  WayfernConfig,
} from "@/types";

type GateRequest = {
  profile: BrowserProfile;
  findings: GateFindings;
};

type LaunchResult = {
  status: "launched" | "cancelled" | "blocked";
};

/**
 * Rebuild the mismatch detail the gate dialog renders from a
 * FINGERPRINT_EXIT_MISMATCH error's params. Every param is a string, because
 * backend error params always are.
 */
function consistencyFromErrorParams(
  params?: Record<string, string>,
): ConsistencyResult {
  return {
    consistent: false,
    checked: true,
    exit_ip: params?.exitIp || null,
    exit_country_code: params?.exitCountry || null,
    exit_timezone: params?.exitTimezone || null,
    fingerprint_timezone: params?.fingerprintTimezone || null,
    fingerprint_language: params?.fingerprintLanguage || null,
    mismatches: (params?.mismatches ?? "").split(",").filter(Boolean),
    // Carried through rather than defaulted to empty: a dimension nothing
    // compared must not be rebuilt here as a dimension that passed.
    unverified: (params?.unverified ?? "").split(",").filter(Boolean),
  };
}

type BrowserTypeString = "wayfern";

interface PendingUrl {
  id: string;
  url: string;
}

export default function Home() {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  // Mount global version update listener/toasts
  useVersionUpdater();
  useDocumentLanguage();

  // Use the new profile events hook for centralized profile management
  const {
    profiles,
    runningProfiles,
    isLoading: profilesLoading,
    error: profilesError,
    loadProfiles,
  } = useProfileEvents();
  useLaunchNotices(profiles);

  // First-run product tour: coach marks on the real controls.
  const [tour, setTour] = useState<{ open: boolean; step: TourStep }>({
    open: false,
    step: 0,
  });
  const onboardingHandledRef = useRef(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [thankYouOpen, setThankYouOpen] = useState(false);
  // null = onboarding decision pending; false = not a first-run session (run
  // normal permission checks); true = first-run session, so "Not now" really
  // defers the standalone permission dialog until a later launch.
  const [firstRunOnboarding, setFirstRunOnboarding] = useState<boolean | null>(
    null,
  );

  const persistOnboardingComplete = useCallback(() => {
    void invoke("complete_onboarding").catch((err: unknown) => {
      console.error("Failed to persist onboarding completion:", err);
    });
  }, []);

  // Welcome flow finished. Existing-profile users are done after the welcome +
  // commercial-use steps; users with no profile yet continue into the in-app
  // product tour that walks them through creating their first profile.
  const handleWelcomeComplete = useCallback(() => {
    setWelcomeOpen(false);
    if (profiles.length === 0) {
      setTour({ open: true, step: 0 });
    } else {
      persistOnboardingComplete();
    }
  }, [persistOnboardingComplete, profiles.length]);

  // Finishing or skipping the product tour completes the one-shot
  // onboarding. Only reaching the end earns the celebration.
  const skipTour = useCallback(() => {
    setTour((current) => ({ ...current, open: false }));
    persistOnboardingComplete();
  }, [persistOnboardingComplete]);
  const finishTour = useCallback(() => {
    setTour((current) => ({ ...current, open: false }));
    persistOnboardingComplete();
    setThankYouOpen(true);
  }, [persistOnboardingComplete]);

  // Suppress the global browser-download toasts while onboarding (welcome or
  // tour) is active — the welcome dialog shows setup progress itself.
  useEffect(() => {
    setOnboardingActive(welcomeOpen || tour.open);
  }, [welcomeOpen, tour.open]);

  // On the very first launch, always show the welcome + commercial-use steps.
  // The completion flag is only persisted after the user finishes or skips the
  // full flow, so an interrupted setup can recover on the next launch.
  // The welcome dialog itself decides whether to continue into the browser
  // download + profile-creation flow — only when the user has no profile yet.
  useEffect(() => {
    if (profilesLoading || onboardingHandledRef.current) return;
    onboardingHandledRef.current = true;
    void (async () => {
      try {
        const completed = await invoke<boolean>("get_onboarding_completed");
        if (completed) {
          setFirstRunOnboarding(false);
          return;
        }
        setFirstRunOnboarding(true);
        setWelcomeOpen(true);
      } catch (err) {
        console.error("Onboarding init failed:", err);
        setFirstRunOnboarding(false);
      }
    })();
  }, [profilesLoading]);

  // The "create a profile" step moves on to "DNS blocking" as soon as the
  // first profile exists. The coach mark finds the new row's DNS control by
  // itself once the row renders.
  useEffect(() => {
    if (tour.open && tour.step === 0 && profiles.length > 0) {
      setTour({ open: true, step: 1 });
    }
  }, [tour.open, tour.step, profiles.length]);

  const {
    groups: groupsData,
    isLoading: groupsLoading,
    error: groupsError,
    loadGroups,
  } = useGroupEvents();
  const profileStatuses = useProfileStatuses();

  const {
    storedProxies,
    isLoading: proxiesLoading,
    error: proxiesError,
  } = useProxyEvents();

  const { vpnConfigs } = useVpnEvents();

  // Extension groups feed both the table's Ext column and the search filter's
  // `ext:` lookup, so the list is loaded here and handed down rather than
  // fetched twice. Refreshed when the backend emits 'extensions-changed'
  // (group rename/create/delete).
  const [extensionGroups, setExtensionGroups] = useState<ExtensionGroup[]>([]);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    const load = async () => {
      try {
        const data = await invoke<ExtensionGroup[]>("list_extension_groups");
        if (mounted) setExtensionGroups(data);
      } catch (e) {
        console.error("Failed to load extension groups:", e);
      }
    };
    void load();
    void listen("extensions-changed", () => {
      void load();
    }).then((u) => {
      if (mounted) unlisten = u;
      else u();
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  // Synchronizer sessions
  const {
    sessions: syncSessions,
    getProfileSyncInfo,
    applySession,
  } = useSyncSessions();
  const [syncLeaderProfile, setSyncLeaderProfile] =
    useState<BrowserProfile | null>(null);

  // Wayfern terms and commercial trial hooks
  const {
    termsAccepted,
    isLoading: termsLoading,
    checkTerms,
  } = useWayfernTerms();
  const {
    trialStatus,
    hasAcknowledged: trialAcknowledged,
    checkTrialStatus,
  } = useCommercialTrial();

  // Cloud auth for cross-OS unlock
  const {
    user: cloudUser,
    loggedInAt: cloudLoggedInAt,
    isLoading: cloudAuthLoading,
  } = useCloudAuth();
  const crossOsUnlocked = getEntitlements(cloudUser).crossOsFingerprints;
  // Shown once when the commercial trial runs out; modal, so it goes first.
  const commercialTrialModalOpen =
    !termsLoading &&
    termsAccepted === true &&
    trialStatus?.type === "Expired" &&
    !trialAcknowledged &&
    !crossOsUnlocked;
  // Bulk run/stop is a paid (browser automation) feature, matching the
  // /v1/profiles/batch/run API gate. Free/solo users see the bulk Run/Stop
  // actions disabled with a Pro badge.
  const automationUnlocked = getEntitlements(cloudUser).browserAutomation;
  // The rail needs to show a live run from every page, so the shell subscribes
  // to the shared cookie-bot store too. It is a module singleton, so this costs
  // one more listener and no extra request. This is also what starts the event
  // stream for a user who signs in without restarting the app.
  const {
    liveSessions: cookieBotLiveSessions,
    schedules: cookieBotSchedules,
    isLoading: cookieBotLoading,
  } = useCookieBot(canUseCookieBot(cloudUser), cookieBotScopeFor(cloudUser));

  const [selfHostedSyncConfigured, setSelfHostedSyncConfigured] =
    useState(false);

  const checkSelfHostedSync = useCallback(async () => {
    try {
      const settings = await invoke<SyncSettings>("get_sync_settings");
      const hasConfig = Boolean(
        settings.sync_server_url && settings.sync_token,
      );
      setSelfHostedSyncConfigured(
        hasConfig && (settings.source === "self_hosted" || !cloudUser),
      );
    } catch {
      setSelfHostedSyncConfigured(false);
    }
  }, [cloudUser]);

  // Cloud sync follows `cloudBackup`, NOT `crossOsFingerprints`. They agreed on
  // every plan until Solo, which buys 20 cloud backups and deliberately has no
  // fingerprint editing — so deriving sync from the fingerprint capability put a
  // Pro badge on the one feature a Solo customer is paying for.
  const cloudBackupUnlocked = getEntitlements(cloudUser).cloudBackup;
  const syncUnlocked = cloudBackupUnlocked || selfHostedSyncConfigured;

  // Feature tips and the paid-plan welcome wait for a settled app: not the
  // first-run session, terms accepted, nothing modal in the way. The usage
  // lists let the inline tip skip a feature the user already has in use.
  const tipUsage = useMemo(
    () => ({
      loaded: !groupsLoading && !proxiesLoading && !cookieBotLoading,
      profiles,
      groupCount: groupsData.length,
      extensionGroupCount: extensionGroups.length,
      vpnCount: vpnConfigs.length,
      cookieBotEnrolled:
        Object.keys(cookieBotSchedules).length > 0 ||
        Object.keys(cookieBotLiveSessions).length > 0,
      syncServerConfigured: selfHostedSyncConfigured,
      proxyIds: storedProxies.map((proxy) => proxy.id),
    }),
    [
      groupsLoading,
      proxiesLoading,
      cookieBotLoading,
      profiles,
      groupsData.length,
      extensionGroups.length,
      vpnConfigs.length,
      cookieBotSchedules,
      cookieBotLiveSessions,
      selfHostedSyncConfigured,
      storedProxies,
    ],
  );
  const settledLaunch =
    firstRunOnboarding === false &&
    !profilesLoading &&
    !welcomeOpen &&
    !thankYouOpen &&
    !tour.open &&
    !termsLoading &&
    termsAccepted === true &&
    !commercialTrialModalOpen;

  const [currentPage, setCurrentPage] = useState<AppPage>("profiles");
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  // Which way the page transition moves: down the rail or back up it.
  const [pageMove, setPageMove] = useState<{ page: AppPage; dir: 1 | -1 }>({
    page: currentPage,
    dir: 1,
  });
  if (pageMove.page !== currentPage) {
    setPageMove({
      page: currentPage,
      dir: pageDirection(pageMove.page, currentPage),
    });
  }
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  // Tracks which tab inside the shared proxy-management page should be active.
  // The VPN rail item routes to the same page but pre-selects the VPN tab.
  const [proxyManagementInitialTab, setProxyManagementInitialTab] = useState<
    "proxies" | "vpns"
  >("proxies");
  const [extensionManagementInitialTab, setExtensionManagementInitialTab] =
    useState<"extensions" | "groups">("extensions");
  const [integrationsInitialTab, setIntegrationsInitialTab] = useState<
    "api" | "remote"
  >("api");
  const [cookieBotDialogOpen, setCookieBotDialogOpen] = useState(false);
  const [totpToolOpen, setTotpToolOpen] = useState(false);
  const [cookieBotInitialTab, setCookieBotInitialTab] =
    useState<CookieBotTab>("overview");
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [agentInitialTab, setAgentInitialTab] =
    useState<AgentTab>("conversation");
  const [createProfileDialogOpen, setCreateProfileDialogOpen] = useState(false);
  const teamReadOnly = isTeamLauncher(cloudUser);
  const teamReadOnlyRef = useRef(teamReadOnly);
  teamReadOnlyRef.current = teamReadOnly;
  // A launcher's new profile would be refused; say so before the form is
  // filled in, not after.
  const openCreateProfile = useCallback(() => {
    if (teamReadOnlyRef.current) {
      showErrorToast(t("backendErrors.teamRoleReadOnly"));
      return;
    }
    setCreateProfileDialogOpen(true);
  }, [t]);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  // A settings section to land on, set by a tip's action for one opening.
  const [settingsInitialSection, setSettingsInitialSection] = useState<
    string | null
  >(null);
  const [trashPageOpen, setTrashPageOpen] = useState(false);
  const [integrationsDialogOpen, setIntegrationsDialogOpen] = useState(false);
  const [importProfileDialogOpen, setImportProfileDialogOpen] = useState(false);
  const [proxyManagementDialogOpen, setProxyManagementDialogOpen] =
    useState(false);
  const [wayfernConfigDialogOpen, setWayfernConfigDialogOpen] = useState(false);
  const [groupManagementDialogOpen, setGroupManagementDialogOpen] =
    useState(false);
  const [extensionManagementDialogOpen, setExtensionManagementDialogOpen] =
    useState(false);
  const [groupAssignmentDialogOpen, setGroupAssignmentDialogOpen] =
    useState(false);
  const [
    extensionGroupAssignmentDialogOpen,
    setExtensionGroupAssignmentDialogOpen,
  ] = useState(false);
  const [
    selectedProfilesForExtensionGroup,
    setSelectedProfilesForExtensionGroup,
  ] = useState<string[]>([]);
  const [proxyAssignmentDialogOpen, setProxyAssignmentDialogOpen] =
    useState(false);
  const [cookieCopyDialogOpen, setCookieCopyDialogOpen] = useState(false);
  const [cookieManagementDialogOpen, setCookieManagementDialogOpen] =
    useState(false);
  const [
    currentProfileForCookieManagement,
    setCurrentProfileForCookieManagement,
  ] = useState<BrowserProfile | null>(null);
  const [selectedProfilesForCookies, setSelectedProfilesForCookies] = useState<
    string[]
  >([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("__all__");
  const [selectedProfilesForGroup, setSelectedProfilesForGroup] = useState<
    string[]
  >([]);
  const [selectedProfilesForProxy, setSelectedProfilesForProxy] = useState<
    string[]
  >([]);
  const [proxyDistributionDialogOpen, setProxyDistributionDialogOpen] =
    useState(false);
  const [selectedProfilesForDistribution, setSelectedProfilesForDistribution] =
    useState<string[]>([]);
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [pendingUrls, setPendingUrls] = useState<PendingUrl[]>([]);
  const [currentProfileForWayfernConfig, setCurrentProfileForWayfernConfig] =
    useState<BrowserProfile | null>(null);
  const [cloneProfile, setCloneProfile] = useState<BrowserProfile | null>(null);
  const [passwordDialogProfile, setPasswordDialogProfile] =
    useState<BrowserProfile | null>(null);
  const [passwordDialogMode, setPasswordDialogMode] =
    useState<PasswordDialogMode>("set");
  const pendingLaunchAfterUnlockRef = useRef<BrowserProfile | null>(null);
  const [windowResizeWarningOpen, setWindowResizeWarningOpen] = useState(false);
  const windowResizeWarningResolver = useRef<
    ((proceed: boolean) => void) | null
  >(null);
  const [permissionDialogOpen, setPermissionDialogOpen] = useState(false);
  const [currentPermissionType, setCurrentPermissionType] =
    useState<PermissionType>("microphone");
  const [showBulkDeleteConfirmation, setShowBulkDeleteConfirmation] =
    useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [syncConfigDialogOpen, setSyncConfigDialogOpen] = useState(false);
  const [deviceCodeDialogOpen, setDeviceCodeDialogOpen] = useState(false);
  const [syncAllDialogOpen, setSyncAllDialogOpen] = useState(false);
  const [profileSyncDialogOpen, setProfileSyncDialogOpen] = useState(false);
  const [currentProfileForSync, setCurrentProfileForSync] =
    useState<BrowserProfile | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  // Pre-launch gate. Requests queue instead of overwriting a single resolver:
  // a bulk run enqueues one per profile, and every waiter must settle or the
  // Promise.allSettled below it never resolves and the bulk spinner sticks.
  const gateQueueRef = useRef<
    Array<{
      id: number;
      req: GateRequest;
      /// The bulk run this request belongs to, or undefined for a single
      /// launch. Carried per entry so a blanket "apply to the rest" can only
      /// ever claim the run its own dialog came from.
      runId: number | undefined;
      resolve: (decision: GateDecision) => void;
    }>
  >([]);
  const gateRequestSeqRef = useRef(0);
  const [gateState, setGateState] = useState<{
    id: number;
    req: GateRequest;
    remaining: number;
  } | null>(null);
  // Set when the user ticks "apply to the remaining profiles" during a bulk
  // run, so the rest are answered without prompting again. Scoped to one bulk
  // run and to the severity it was given for.
  const blanketGateDecisionRef = useRef<{
    decision: GateDecision;
    /// Only auto-answers gates no more severe than the one the user saw. A
    /// choice made on an extension warning must never silently bypass a hard
    /// block on a later profile.
    coversBlocking: boolean;
    /// Identifies the bulk run, so a single launch started while a bulk run is
    /// in flight still gets its own dialog.
    runId: number;
  } | null>(null);
  const bulkRunIdRef = useRef(0);
  // Owned by page.tsx so the command palette can request opening the profile
  // info dialog. ProfilesDataTable consumes it through controlled props.
  const [profileInfoDialog, setProfileInfoDialog] =
    useState<BrowserProfile | null>(null);
  const [profileInfoOpenMethod, setProfileInfoOpenMethod] = useState<
    "pointer" | "keyboard"
  >("pointer");
  const { isMicrophoneAccessGranted, isCameraAccessGranted, isInitialized } =
    usePermissions();

  const handleSelectGroup = useCallback((groupId: string) => {
    setSelectedGroupId(groupId);
    setSelectedProfiles([]);
  }, []);

  // Run a navigation that unmounts the current page, after the person chose
  // what happens to unsaved edits on it. With nothing unsaved it runs at
  // once, in the caller's batch.
  const guardLeave = useCallback((go: () => void) => {
    if (!hasUnsavedChanges()) {
      go();
      return;
    }
    void confirmLeave().then((ok) => {
      if (ok) go();
    });
  }, []);

  const navigateNow = useCallback((page: AppPage) => {
    // Always reset every sub-page-able dialog before opening the next one,
    // so navigating from one rail item to another doesn't stack two
    // sub-pages on top of each other.
    setSettingsDialogOpen(false);
    setProxyManagementDialogOpen(false);
    setExtensionManagementDialogOpen(false);
    setGroupManagementDialogOpen(false);
    setIntegrationsDialogOpen(false);
    setImportProfileDialogOpen(false);
    setAccountDialogOpen(false);
    setCookieBotDialogOpen(false);
    setAgentDialogOpen(false);
    setTrashPageOpen(false);
    setSettingsInitialSection(null);

    setCurrentPage(page);
    switch (page) {
      case "profiles":
        break;
      case "settings":
        setSettingsDialogOpen(true);
        break;
      case "proxies":
        setProxyManagementInitialTab("proxies");
        setProxyManagementDialogOpen(true);
        break;
      case "extensions":
        setExtensionManagementDialogOpen(true);
        break;
      case "groups":
        setGroupManagementDialogOpen(true);
        break;
      case "cookieBot":
        setCookieBotDialogOpen(true);
        break;
      case "agent":
        setAgentDialogOpen(true);
        break;
      case "integrations":
        setIntegrationsDialogOpen(true);
        break;
      case "import":
        setImportProfileDialogOpen(true);
        break;
      case "vpns":
        // VPNs share the proxy management page; pre-select the VPN tab so
        // the user lands directly on the right list.
        setProxyManagementInitialTab("vpns");
        setProxyManagementDialogOpen(true);
        break;
      case "account":
        setAccountDialogOpen(true);
        break;
      case "trash":
        setTrashPageOpen(true);
        break;
      case "shortcuts":
        // Plain page render — nothing else to open.
        break;
    }
  }, []);

  const handleRailNavigate = useCallback(
    (page: AppPage) => {
      const from = currentPageRef.current;
      const network = (p: AppPage) => p === "proxies" || p === "vpns";
      // Same page (or Proxies <-> VPNs, one page with two tabs): nothing
      // unmounts, so nothing can be lost.
      if (page === from || (network(page) && network(from))) {
        navigateNow(page);
        return;
      }
      guardLeave(() => navigateNow(page));
    },
    [guardLeave, navigateNow],
  );

  /** Go to Profiles, then run `then` there; asks first like any navigation. */
  const goToProfilesThen = useCallback(
    (then: () => void) => {
      if (currentPageRef.current === "profiles") {
        then();
        return;
      }
      guardLeave(() => {
        navigateNow("profiles");
        then();
      });
    },
    [guardLeave, navigateNow],
  );

  /** A sub-page's own back or close: leave it for Profiles. */
  const closeSubPage = useCallback(
    (close: () => void) => {
      guardLeave(() => {
        close();
        setCurrentPage("profiles");
      });
    },
    [guardLeave],
  );

  const openAgentConversation = useCallback(() => {
    setAgentInitialTab("conversation");
    handleRailNavigate("agent");
  }, [handleRailNavigate]);
  const agentConsole = useAgentConsole({
    onOpenPage: openAgentConversation,
    pageVisible: currentPage === "agent",
  });

  const tipsFlow = useTips({
    cloudUser,
    accountLoading: cloudAuthLoading,
    loggedInAt: cloudLoggedInAt,
    ready: settledLaunch,
    usage: tipUsage,
    activity: {
      page: currentPage,
      paletteOpen: commandPaletteOpen,
      searchQuery,
      totpOpen: totpToolOpen,
      synchronizing: syncSessions.length > 0,
    },
  });
  const { openTips, closeTips } = tipsFlow;

  const runTipAction = useCallback(
    (action: TipAction) => {
      closeTips();
      switch (action.kind) {
        case "page":
          handleRailNavigate(action.page);
          break;
        case "settings": {
          // The navigation clears the section; setting it afterwards in the
          // same batch is what makes it win.
          const section = action.section;
          const open = () => {
            navigateNow("settings");
            setSettingsInitialSection(section);
          };
          if (currentPageRef.current === "settings") open();
          else guardLeave(open);
          break;
        }
        case "palette":
          setCommandPaletteOpen(true);
          break;
        case "feedback":
          setFeedbackDialogOpen(true);
          break;
        case "search": {
          const query = action.query;
          goToProfilesThen(() => {
            setSelectedProfiles([]);
            setSearchQuery(query);
          });
          break;
        }
        case "createProfile":
          goToProfilesThen(openCreateProfile);
          break;
        case "totp":
          setTotpToolOpen(true);
          break;
      }
    },
    [
      closeTips,
      handleRailNavigate,
      navigateNow,
      guardLeave,
      goToProfilesThen,
      openCreateProfile,
    ],
  );

  // Set once the launch and stop handlers below exist.
  const stopAllRunningRef = useRef<() => void>(() => {});

  const focusProfileSearch = useCallback(() => {
    const focus = () => {
      const input = document.getElementById("profile-search-input");
      if (!(input instanceof HTMLInputElement)) return;
      if (document.activeElement === input) return;
      input.focus();
      input.select();
    };
    goToProfilesThen(() => {
      // The page may mount this frame, and a closing palette hands focus
      // back to its trigger a moment later: keep it on the search box.
      for (let delay = 0; delay <= 360; delay += 60) {
        window.setTimeout(focus, delay);
      }
    });
  }, [goToProfilesThen]);

  const runShortcut = useCallback(
    (id: ShortcutId) => {
      switch (id) {
        case "newProfile":
          openCreateProfile();
          break;
        case "stopAllRunning":
          stopAllRunningRef.current();
          break;
        case "focusSearch":
          focusProfileSearch();
          break;
        case "goBack":
          handleRailNavigate("profiles");
          break;
        case "openPalette":
          setCommandPaletteOpen(true);
          break;
        case "openTips":
          openTips();
          break;
        case "sendFeedback":
          setFeedbackDialogOpen(true);
          break;
        case "openShortcuts":
          handleRailNavigate("shortcuts");
          break;
        case "importProfile":
          handleRailNavigate("import");
          break;
        case "goProfiles":
          handleRailNavigate("profiles");
          break;
        case "goProxies": {
          // Mod+Shift+N: navigate first time; flip proxies↔vpns on subsequent presses.
          // handleRailNavigate("proxies"|"vpns") already updates the dialog's
          // initialTab, so we just pick the right destination.
          if (currentPage === "proxies") {
            handleRailNavigate("vpns");
          } else if (currentPage === "vpns") {
            handleRailNavigate("proxies");
          } else {
            handleRailNavigate(
              proxyManagementInitialTab === "vpns" ? "vpns" : "proxies",
            );
          }
          break;
        }
        case "goExtensions": {
          // Mod+E: flip extensions↔groups tab inside the dialog when already there.
          if (currentPage === "extensions") {
            setExtensionManagementInitialTab((cur) =>
              cur === "extensions" ? "groups" : "extensions",
            );
          } else {
            handleRailNavigate("extensions");
          }
          break;
        }
        case "goGroups":
          handleRailNavigate("groups");
          break;
        case "goCookieBot": {
          // Mod+B: navigate first time; flip overview↔activity while already
          // there, matching how Mod+I flips the integrations tabs.
          if (currentPage === "cookieBot") {
            setCookieBotInitialTab((cur) =>
              cur === "overview" ? "activity" : "overview",
            );
          } else {
            setCookieBotInitialTab("overview");
            handleRailNavigate("cookieBot");
          }
          break;
        }
        case "goAgent": {
          // Mod+J: navigate first time; flip conversation↔activity while
          // already there, matching how Mod+B flips the Cookie Bot tabs.
          if (currentPage === "agent") {
            setAgentInitialTab((cur) =>
              cur === "conversation" ? "activity" : "conversation",
            );
          } else {
            openAgentConversation();
          }
          break;
        }
        case "goIntegrations": {
          // Mod+I: flip the tabs when already on integrations. The Remote MCP
          // tab only exists for a user entitled to remote control, so everyone
          // else stays on the API tab.
          if (currentPage === "integrations") {
            setIntegrationsInitialTab((cur) =>
              cur === "api" && canUseRemoteControl(cloudUser)
                ? "remote"
                : "api",
            );
          } else {
            handleRailNavigate("integrations");
          }
          break;
        }
        case "goAccount":
          handleRailNavigate("account");
          break;
        case "goSettings":
          handleRailNavigate("settings");
          break;
        case "goTrash":
          handleRailNavigate("trash");
          break;
        case "openTotp":
          setTotpToolOpen(true);
          break;
      }
    },
    [
      handleRailNavigate,
      currentPage,
      proxyManagementInitialTab,
      cloudUser,
      openTips,
      openAgentConversation,
      openCreateProfile,
      focusProfileSearch,
    ],
  );

  // Ordered list the digit shortcuts and palette consume. "__all__" is index 1
  // so Mod+1 always lands on the unfiltered view; the user's groups follow.
  const orderedGroupTargets = useMemo(
    () => [
      { id: "__all__", name: t("rail.profiles") },
      ...groupsData.map((g) => ({ id: g.id, name: g.name })),
    ],
    [groupsData, t],
  );

  const selectGroupByDigit = useCallback(
    (digit: number) => {
      const target = orderedGroupTargets[digit - 1];
      if (!target) return;
      goToProfilesThen(() => handleSelectGroup(target.id));
    },
    [orderedGroupTargets, goToProfilesThen, handleSelectGroup],
  );

  useEffect(() => {
    // Global keydown — handles Mod+1..9 group jumps first, then falls back to
    // the static SHORTCUTS table. Skipped while typing in an input, EXCEPT
    // ⌘K and ⌘/ which are meta-level shortcuts and should always be reachable.
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isTyping =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable === true;

      const digit = matchesGroupDigit(e);
      if (digit !== null) {
        if (isTyping) return;
        if (digit - 1 >= orderedGroupTargets.length) return;
        e.preventDefault();
        selectGroupByDigit(digit);
        return;
      }

      for (const s of SHORTCUTS) {
        if (!matchesShortcut(s, e)) continue;
        if (isTyping && s.id !== "openPalette" && s.id !== "openShortcuts") {
          return;
        }
        if (s.id === "goBack") {
          // Escape leaves a sub-page only when nothing on it took the key:
          // an open dialog, popover, menu or table selection goes first.
          if (
            e.defaultPrevented ||
            e.repeat ||
            currentPageRef.current === "profiles" ||
            document.querySelector(
              '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-slot="table-action-bar"]',
            )
          ) {
            return;
          }
          e.preventDefault();
          playUiSound("close");
          runShortcut(s.id);
          return;
        }
        e.preventDefault();
        playUiSound("open");
        runShortcut(s.id);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [runShortcut, selectGroupByDigit, orderedGroupTargets.length]);

  // The classic cheat code pays out in sprinkles. Nothing else changes: it
  // touches no profile, setting, or file, so it is safe anywhere in the app.
  useKonamiCode(
    useCallback(() => {
      showSuccessToast(t("easterEgg.konami.title"), {
        id: "cheat-code",
        description: t("easterEgg.konami.description"),
      });
      window.dispatchEvent(new CustomEvent("donut-cheat-code"));
      if (!reducedMotion) fireSprinkleConfetti();
    }, [reducedMotion, t]),
  );

  // Check for missing binaries and offer to download them
  const checkMissingBinaries = useCallback(async () => {
    try {
      const missingBinaries = await invoke<[string, string, string][]>(
        "check_missing_binaries",
      );

      // Also check for missing GeoIP database
      const missingGeoIP = await invoke<boolean>(
        "check_missing_geoip_database",
      );

      if (missingBinaries.length > 0 || missingGeoIP) {
        if (missingBinaries.length > 0) {
          console.log("Found missing binaries:", missingBinaries);
        }
        if (missingGeoIP) {
          console.log("Found missing GeoIP database");
        }

        // Group missing binaries by browser type to avoid concurrent downloads
        const browserMap = new Map<string, string[]>();
        for (const [profileName, browser, version] of missingBinaries) {
          if (!browserMap.has(browser)) {
            browserMap.set(browser, []);
          }
          const versions = browserMap.get(browser);
          if (versions) {
            versions.push(`${version} (for ${profileName})`);
          }
        }

        // Show a toast notification about missing binaries and auto-download them
        let missingList = Array.from(browserMap.entries())
          .map(([browser, versions]) => `${browser}: ${versions.join(", ")}`)
          .join(", ");

        if (missingGeoIP) {
          if (missingList) {
            missingList += ", GeoIP database";
          } else {
            missingList = "GeoIP database";
          }
        }

        console.log(`Downloading missing components: ${missingList}`);

        try {
          // Download missing binaries and GeoIP database sequentially to prevent conflicts
          const downloaded = await invoke<string[]>(
            "ensure_all_binaries_exist",
          );
          if (downloaded.length > 0) {
            console.log(
              "Successfully downloaded missing components:",
              downloaded,
            );
          }
        } catch (downloadError) {
          console.error(
            "Failed to download missing components:",
            downloadError,
          );
        }
      }
    } catch (err: unknown) {
      console.error("Failed to check missing components:", err);
    }
  }, []);

  const [processingUrls, setProcessingUrls] = useState<Set<string>>(new Set());

  const handleUrlOpen = useCallback(
    (url: string) => {
      // Prevent duplicate processing of the same URL
      if (processingUrls.has(url)) {
        console.log("URL already being processed:", url);
        return;
      }

      setProcessingUrls((prev) => new Set(prev).add(url));

      try {
        console.log("URL received for opening:", url);

        // Always show profile selector for manual selection - never auto-open
        // Replace any existing pending URL with the new one
        setPendingUrls([{ id: Date.now().toString(), url }]);
      } finally {
        // Remove URL from processing set after a short delay to prevent rapid duplicates
        setTimeout(() => {
          setProcessingUrls((prev) => {
            const next = new Set(prev);
            next.delete(url);
            return next;
          });
        }, 1000);
      }
    },
    [processingUrls],
  );

  // Auto-update functionality - use the existing hook for compatibility
  const updateNotifications = useUpdateNotifications();
  const { checkForUpdates, isUpdating } = updateNotifications;

  const appUpdate = useAppUpdateNotifications();

  // Check for startup URLs but only process them once
  const [hasCheckedStartupUrl, setHasCheckedStartupUrl] = useState(false);
  const checkCurrentUrl = useCallback(async () => {
    if (hasCheckedStartupUrl) return;

    try {
      const currentUrl = await getCurrent();
      if (currentUrl && currentUrl.length > 0) {
        console.log("Startup URL detected:", currentUrl[0]);
        handleUrlOpen(currentUrl[0]);
      }
    } catch (error) {
      console.error("Failed to check current URL:", error);
    } finally {
      setHasCheckedStartupUrl(true);
    }
  }, [handleUrlOpen, hasCheckedStartupUrl]);

  // Handle profile errors from useProfileEvents hook
  useEffect(() => {
    if (profilesError) {
      showErrorToast(profilesError);
    }
  }, [profilesError]);

  // Handle group errors from useGroupEvents hook
  useEffect(() => {
    if (groupsError) {
      showErrorToast(groupsError);
    }
  }, [groupsError]);

  // Handle proxy errors from useProxyEvents hook
  useEffect(() => {
    if (proxiesError) {
      showErrorToast(proxiesError);
    }
  }, [proxiesError]);

  const checkAllPermissions = useCallback(() => {
    try {
      // Wait for permissions to be initialized before checking
      if (!isInitialized) {
        return;
      }

      // Check if any permissions are not granted - prioritize missing permissions
      if (!isMicrophoneAccessGranted) {
        setCurrentPermissionType("microphone");
        setPermissionDialogOpen(true);
      } else if (!isCameraAccessGranted) {
        setCurrentPermissionType("camera");
        setPermissionDialogOpen(true);
      }
    } catch (error) {
      console.error("Failed to check permissions:", error);
    }
  }, [isMicrophoneAccessGranted, isCameraAccessGranted, isInitialized]);

  const checkNextPermission = useCallback(
    (justGranted?: PermissionType) => {
      try {
        // Treat the just-granted permission as granted even when this
        // callback's state does not show it yet, so the dialog never stays
        // on the permission the user just granted.
        const micGranted =
          isMicrophoneAccessGranted || justGranted === "microphone";
        const camGranted = isCameraAccessGranted || justGranted === "camera";

        if (!micGranted) {
          setCurrentPermissionType("microphone");
          setPermissionDialogOpen(true);
        } else if (!camGranted) {
          setCurrentPermissionType("camera");
          setPermissionDialogOpen(true);
        } else {
          setPermissionDialogOpen(false);
        }
      } catch (error) {
        console.error("Failed to check next permission:", error);
      }
    },
    [isMicrophoneAccessGranted, isCameraAccessGranted],
  );

  const listenForUrlEvents = useCallback(async () => {
    // Collect every listener we register so that — whether setup completes or
    // throws partway through — we tear down exactly what was registered.
    // Previously the Tauri unlisten handles were discarded (so re-runs stacked
    // duplicate handlers and a single URL was handled N times), and a failing
    // listen() call would leak the listeners that had already succeeded.
    const unlisteners: Array<() => void> = [];
    let handleLogoUrlEvent: ((event: CustomEvent) => void) | undefined;
    const teardown = () => {
      for (const unlisten of unlisteners) unlisten();
      if (handleLogoUrlEvent) {
        window.removeEventListener(
          "url-open-request",
          handleLogoUrlEvent as EventListener,
        );
      }
    };

    try {
      // Listen for URL open events from the deep link handler (when app is already running)
      unlisteners.push(
        await listen<string>("url-open-request", (event) => {
          console.log("Received URL open request:", event.payload);
          handleUrlOpen(event.payload);
        }),
      );

      // Listen for show profile selector events
      unlisteners.push(
        await listen<string>("show-profile-selector", (event) => {
          console.log("Received show profile selector request:", event.payload);
          handleUrlOpen(event.payload);
        }),
      );

      // Listen for show create profile dialog events
      unlisteners.push(
        await listen<string>("show-create-profile-dialog", (event) => {
          console.log(
            "Received show create profile dialog request:",
            event.payload,
          );
          showErrorToast(t("errors.noProfilesForUrl"));
          if (!teamReadOnlyRef.current) setCreateProfileDialogOpen(true);
        }),
      );

      // Listen for custom logo click events
      handleLogoUrlEvent = (event: CustomEvent) => {
        console.log("Received logo URL event:", event.detail);
        handleUrlOpen(event.detail);
      };
      window.addEventListener(
        "url-open-request",
        handleLogoUrlEvent as EventListener,
      );

      return teardown;
    } catch (error) {
      console.error("Failed to setup URL listener:", error);
      // Tear down whatever did register before the failure so nothing leaks.
      teardown();
    }
  }, [handleUrlOpen, t]);

  const handleConfigureWayfern = useCallback((profile: BrowserProfile) => {
    setCurrentProfileForWayfernConfig(profile);
    setWayfernConfigDialogOpen(true);
  }, []);

  const handleSaveWayfernConfig = useCallback(
    async (profile: BrowserProfile, config: WayfernConfig) => {
      try {
        await invoke("update_wayfern_config", {
          profileId: profile.id,
          config,
        });
        // No need to manually reload - useProfileEvents will handle the update
        setWayfernConfigDialogOpen(false);
      } catch (err: unknown) {
        console.error("Failed to update wayfern config:", err);
        throw err;
      }
    },
    [],
  );

  const handleCreateProfile = useCallback(
    async (profileData: {
      name: string;
      browserStr: BrowserTypeString;
      version: string;
      releaseType: string;
      proxyId?: string;
      vpnId?: string;
      wayfernConfig?: WayfernConfig;
      /** `null`: the person picked "No group" in the create dialog. */
      groupId?: string | null;
      extensionGroupId?: string;
      ephemeral?: boolean;
      dnsBlocklist?: string;
      dnsServer?: string;
      startUrls?: string[];
      launchHook?: string;
      password?: string;
    }) => {
      try {
        const profile = await invoke<BrowserProfile>(
          "create_browser_profile_new",
          {
            name: profileData.name,
            browserStr: profileData.browserStr,
            version: profileData.version,
            releaseType: profileData.releaseType,
            proxyId: profileData.proxyId,
            vpnId: profileData.vpnId,
            wayfernConfig: profileData.wayfernConfig,
            groupId:
              profileData.groupId === null
                ? undefined
                : (profileData.groupId ??
                  (selectedGroupId && selectedGroupId !== "__all__"
                    ? selectedGroupId
                    : undefined)),
            ephemeral: profileData.ephemeral,
            dnsBlocklist: profileData.dnsBlocklist,
            dnsServer: profileData.dnsServer,
            launchHook: profileData.launchHook,
            startUrls: profileData.startUrls,
          },
        );

        if (profileData.extensionGroupId) {
          try {
            await invoke("assign_extension_group_to_profile", {
              profileId: profile.id,
              extensionGroupId: profileData.extensionGroupId,
            });
          } catch (err) {
            console.error("Failed to assign extension group:", err);
          }
        }

        if (profileData.password && !profileData.ephemeral) {
          try {
            await invoke("set_profile_password", {
              profileId: profile.id,
              password: profileData.password,
            });
          } catch (err) {
            showErrorToast(
              t("errors.setProfilePasswordFailed", {
                error: translateBackendError(t, err),
              }),
            );
          }
        }

        // No need to manually reload - useProfileEvents will handle the update
      } catch (error) {
        showErrorToast(
          t("errors.createProfileFailed", {
            error: translateBackendError(t, error),
          }),
        );
        // Rethrow so the create dialog keeps itself open (its own handler
        // skips closing on error), letting the user fix the proxy/VPN and retry.
        throw error;
      }
    },
    [selectedGroupId, t],
  );

  // Unattended launches — REST and MCP automation — are the only ones the
  // backend gate lets past a measured mismatch, because there is no dialog for
  // them to answer. Without a listener that finding was emitted into the void.
  useEffect(() => {
    const unlisten = listen<ConsistencyResult>(
      "fingerprint-consistency-warning",
      (event) => {
        const { exit_timezone, fingerprint_timezone } = event.payload;
        showErrorToast(t("backendErrors.fingerprintExitMismatch"), {
          description:
            exit_timezone && fingerprint_timezone
              ? t("consistencyWarning.timezoneDetail", {
                  exit: exit_timezone,
                  fingerprint: fingerprint_timezone,
                })
              : undefined,
          id: `fingerprint-mismatch-${exit_timezone ?? "unknown"}`,
        });
      },
    );
    return () => {
      void unlisten.then((fn) => {
        fn();
      });
    };
  }, [t]);

  useEffect(() => {
    const unlisten = listen<{ profile_name: string; error: string }>(
      "profile-launch-args-skipped",
      (event) => {
        showErrorToast(
          t("fingerprint.launchArgsSkipped", {
            profile: event.payload.profile_name,
            reason: translateBackendError(t, event.payload.error),
          }),
          { id: `launch-args-skipped-${event.payload.profile_name}` },
        );
      },
    );
    return () => {
      void unlisten.then((fn) => {
        fn();
      });
    };
  }, [t]);

  // The third state. The gate reached the exit but the fingerprint declares no
  // value to compare it against, so nothing was verified, which is not a
  // mismatch and never blocks, but is not the clean bill of health that
  // reporting nothing would imply.
  useEffect(() => {
    const unlisten = listen<ConsistencyResult>(
      "fingerprint-consistency-unverified",
      (event) => {
        const { unverified, exit_timezone, exit_country_code } = event.payload;
        if (unverified.length === 0) {
          return;
        }
        showErrorToast(t("consistencyWarning.unverifiedTitle"), {
          description: unverified.includes("timezone")
            ? t("consistencyWarning.unverifiedTimezoneDetail", {
                exit: exit_timezone ?? exit_country_code ?? "?",
              })
            : t("consistencyWarning.unverifiedLanguageDetail", {
                country: exit_country_code ?? "?",
              }),
          id: `fingerprint-unverified-${unverified.join("-")}`,
        });
      },
    );
    return () => {
      void unlisten.then((fn) => {
        fn();
      });
    };
  }, [t]);

  // Show the queue's head, and how many are waiting behind it.
  const syncGateUi = useCallback(() => {
    const queue = gateQueueRef.current;
    setGateState(
      queue.length > 0
        ? { id: queue[0].id, req: queue[0].req, remaining: queue.length - 1 }
        : null,
    );
  }, []);

  const requestGateDecision = useCallback(
    (req: GateRequest, runId?: number): Promise<GateDecision> => {
      const blanket = blanketGateDecisionRef.current;
      const isBlocking = req.findings.fingerprint !== null;
      if (
        blanket &&
        blanket.runId === runId &&
        (blanket.coversBlocking || !isBlocking)
      ) {
        // A blanket answer covers only whether to launch. The acknowledgements
        // it carried were about the first profile's specific mismatch and
        // extensions, and must not be persisted against profiles the user
        // never saw.
        return Promise.resolve({
          ...blanket.decision,
          ackFingerprint: false,
          ackExtensionKeys: [],
        });
      }
      playUiSound("warning");
      return new Promise<GateDecision>((resolve) => {
        gateRequestSeqRef.current += 1;
        gateQueueRef.current.push({
          id: gateRequestSeqRef.current,
          req,
          runId,
          resolve,
        });
        syncGateUi();
      });
    },
    [syncGateUi],
  );

  const settleGate = useCallback(
    (decision: GateDecision) => {
      const entry = gateQueueRef.current.shift();
      if (!entry) {
        return;
      }
      entry.resolve(decision);
      if (decision.applyToRemaining) {
        const coversBlocking = entry.req.findings.fingerprint !== null;
        // Only a bulk run gets a standing blanket, and it claims the run the
        // answered dialog belonged to — never whichever run happens to be in
        // flight when the dialog is settled. Outside a run there is nothing to
        // scope one to, and a session-wide blanket would silently answer
        // unrelated launches later. The queue is still drained either way,
        // which is what the checkbox actually promises.
        if (entry.runId !== undefined) {
          blanketGateDecisionRef.current = {
            decision,
            coversBlocking,
            runId: entry.runId,
          };
        }
        // Drain the queue rather than leaving promises pending forever — but
        // only those the blanket actually covers. A hard block still deserves
        // its own dialog even after the user blanket-approved a warning, and a
        // launch started outside this run was never part of the answer.
        const remaining = gateQueueRef.current.splice(0);
        const kept = [];
        for (const queued of remaining) {
          const covered =
            queued.runId === entry.runId &&
            (coversBlocking || queued.req.findings.fingerprint === null);
          if (!covered) {
            kept.push(queued);
            continue;
          }
          queued.resolve({
            ...decision,
            ackFingerprint: false,
            ackExtensionKeys: [],
          });
        }
        gateQueueRef.current = kept;
      }
      syncGateUi();
    },
    [syncGateUi],
  );

  const persistGateAcks = useCallback(
    async (profileId: string, decision: GateDecision) => {
      // Only on proceed. Cancel is the autofocused default action, so a stray
      // Enter would otherwise permanently disarm the gate for this profile.
      if (!decision.proceed) {
        return;
      }
      if (!decision.ackFingerprint && decision.ackExtensionKeys.length === 0) {
        return;
      }
      try {
        await invoke("ack_launch_gate", {
          profileId,
          ackFingerprint: decision.ackFingerprint,
          ackExtensionKeys: decision.ackExtensionKeys,
        });
      } catch (err) {
        console.warn("Failed to persist launch gate acknowledgement:", err);
      }
    },
    [],
  );

  // The raw error of each profile's last failed launch, shown by the table.
  // An entry goes when that profile launches.
  const [launchErrors, setLaunchErrors] = useState<Record<string, string>>({});
  const noteLaunchError = useCallback((profileId: string, err: unknown) => {
    setLaunchErrors((current) => {
      if (err === null) {
        if (!(profileId in current)) return current;
        const next = { ...current };
        delete next[profileId];
        return next;
      }
      return {
        ...current,
        [profileId]: err instanceof Error ? err.message : String(err),
      };
    });
  }, []);

  const launchProfile = useCallback(
    async (
      profile: BrowserProfile,
      // `quiet`: a bulk run reports failures in one summary instead.
      opts?: { bulkRunId?: number; quiet?: boolean },
    ): Promise<LaunchResult> => {
      console.log("Starting launch for profile:", profile.name);

      // Password-protected: must be unlocked before launch
      if (profile.password_protected) {
        try {
          const isLocked = await invoke<boolean>("is_profile_locked", {
            profileId: profile.id,
          });
          if (isLocked) {
            pendingLaunchAfterUnlockRef.current = profile;
            setPasswordDialogMode("unlock");
            setPasswordDialogProfile(profile);
            return { status: "cancelled" };
          }
        } catch (err) {
          console.error("Failed to check profile lock state:", err);
        }
      }

      // Show one-time warning about window resizing for fingerprinted browsers
      if (profile.browser === "wayfern") {
        try {
          const dismissed = await invoke<boolean>(
            "get_window_resize_warning_dismissed",
          );
          if (!dismissed) {
            const proceed = await new Promise<boolean>((resolve) => {
              windowResizeWarningResolver.current = resolve;
              setWindowResizeWarningOpen(true);
            });
            if (!proceed) {
              return { status: "cancelled" };
            }
          }
        } catch (error) {
          console.error("Failed to check window resize warning:", error);
        }
      }

      // Tier 1: purely local checks — an extension scan and a cached exit
      // verdict. No network, no worker started, so a profile whose exit is
      // already known blocks before the launch touches anything.
      let consentToken: string | null = null;
      // Kept for the tier-2 dialog below: the extensions are the same ones,
      // and a mismatch measured mid-launch is exactly when knowing that one of
      // them can change the proxy matters most. Minus anything the user just
      // acknowledged, so a box they ticked seconds ago is not shown again.
      let localChecks: PreLaunchChecks | null = null;
      let ackedExtensionKeys: string[] = [];
      try {
        // One-shot migration of the old per-profile "don't warn again" flag,
        // so a user who already dismissed this profile isn't hard-blocked by
        // the new gate. Granted against the profile's current exit, which is
        // the mismatch they were looking at when they dismissed it.
        const legacySkipKey = `consistency-warn-skip-${profile.id}`;
        if (localStorage.getItem(legacySkipKey) === "1") {
          await invoke("ack_launch_gate", {
            profileId: profile.id,
            ackFingerprint: true,
            ackExtensionKeys: [],
          }).catch((err: unknown) => {
            console.warn("Failed to migrate consistency skip flag:", err);
          });
          localStorage.removeItem(legacySkipKey);
        }

        const checks = await invoke<PreLaunchChecks>(
          "get_profile_pre_launch_checks",
          { profileId: profile.id },
        );
        localChecks = checks;
        const blocked =
          checks.consistency.checked && !checks.consistency.consistent;
        if (
          blocked ||
          checks.vpn_extensions.length > 0 ||
          checks.route_unreachable
        ) {
          const decision = await requestGateDecision(
            {
              profile,
              findings: {
                vpnExtensions: checks.vpn_extensions,
                scanState: checks.scan_state,
                fingerprint: blocked ? checks.consistency : null,
                measurementUnreliable: checks.exit_measurement_unreliable,
                probePending: checks.exit_probe_pending,
                unverified: checks.exit_unverified,
                routeUnreachable: checks.route_unreachable ?? null,
              },
            },
            opts?.bulkRunId,
          );
          await persistGateAcks(profile.id, decision);
          if (!decision.proceed) {
            return { status: "cancelled" };
          }
          ackedExtensionKeys = decision.ackExtensionKeys;
          consentToken = checks.consent_token;
        }
      } catch (err) {
        // Same posture as the password and window-resize gates: a check that
        // cannot run must not make profiles unlaunchable.
        console.warn("Pre-launch checks failed, launching anyway:", err);
      }

      const causedAt = performance.now();
      try {
        const result = await invoke<BrowserProfile>("launch_browser_profile", {
          profile,
          consentToken,
        });
        console.log("Successfully launched profile:", result.name);
        playUiSound("launch", { causedAt, batch: opts?.bulkRunId });
        noteLaunchError(profile.id, null);
        return { status: "launched" };
      } catch (err: unknown) {
        // Tier 2: the enforcing gate measured the exit mid-launch and stopped
        // before spawning the browser. Offer the same decision, then retry
        // exactly once with the token it minted — bounded, so a gate loop is
        // structurally impossible.
        const parsed = parseBackendError(err);
        if (parsed?.code === "FINGERPRINT_EXIT_MISMATCH") {
          const decision = await requestGateDecision(
            {
              profile,
              findings: {
                vpnExtensions: (localChecks?.vpn_extensions ?? []).filter(
                  (ext) => !ackedExtensionKeys.includes(ext.key),
                ),
                scanState: localChecks?.scan_state ?? "scanned",
                fingerprint: consistencyFromErrorParams(parsed.params),
                measurementUnreliable:
                  localChecks?.exit_measurement_unreliable ?? false,
                probePending: false,
                unverified: localChecks?.exit_unverified ?? [],
              },
            },
            opts?.bulkRunId,
          );
          await persistGateAcks(profile.id, decision);
          if (!decision.proceed) {
            return { status: "cancelled" };
          }
          try {
            const retriedAt = performance.now();
            await invoke<BrowserProfile>("launch_browser_profile", {
              profile,
              consentToken: parsed.params?.token ?? null,
            });
            playUiSound("launch", {
              causedAt: retriedAt,
              batch: opts?.bulkRunId,
            });
            noteLaunchError(profile.id, null);
            return { status: "launched" };
          } catch (retryErr: unknown) {
            noteLaunchError(profile.id, retryErr);
            if (!opts?.quiet) {
              showErrorToast(
                t("errors.launchBrowserFailed", {
                  name: profile.name,
                  error: translateBackendError(t, retryErr),
                }),
              );
            }
            return { status: "blocked" };
          }
        }

        console.error("Failed to launch browser:", err);
        noteLaunchError(profile.id, err);
        if (!opts?.quiet) {
          showErrorToast(
            t("errors.launchBrowserFailed", {
              name: profile.name,
              error: translateBackendError(t, err),
            }),
          );
        }
        throw err;
      }
    },
    [persistGateAcks, requestGateDecision, noteLaunchError, t],
  );

  const handleCloneProfile = useCallback((profile: BrowserProfile) => {
    setCloneProfile(profile);
  }, []);

  const handleSetPassword = useCallback((profile: BrowserProfile) => {
    pendingLaunchAfterUnlockRef.current = null;
    setPasswordDialogMode("set");
    setPasswordDialogProfile(profile);
  }, []);

  const handleChangePassword = useCallback((profile: BrowserProfile) => {
    pendingLaunchAfterUnlockRef.current = null;
    setPasswordDialogMode("change");
    setPasswordDialogProfile(profile);
  }, []);

  const handleRemovePassword = useCallback((profile: BrowserProfile) => {
    pendingLaunchAfterUnlockRef.current = null;
    setPasswordDialogMode("remove");
    setPasswordDialogProfile(profile);
  }, []);

  // The Undo of a move to the trash.
  const restoreFromTrash = useCallback(
    async (profileIds: string[]) => {
      const results = await Promise.allSettled(
        profileIds.map((profileId) =>
          invoke("restore_trashed_profile", { profileId }),
        ),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure) {
        showErrorToast(
          t("trash.restoreFailed", {
            error: translateBackendError(t, failure.reason),
          }),
        );
      }
    },
    [t],
  );

  /**
   * A move to the trash needs no question: it is done, and the toast offers
   * Undo. Ephemeral profiles have no trash; the table confirms those first.
   */
  const announceTrashed = useCallback(
    (trashed: BrowserProfile[]) => {
      const recoverable = trashed.filter((profile) => !profile.ephemeral);
      if (recoverable.length === 0) {
        playUiSound("trash");
        return;
      }
      showUndoToast(
        recoverable.length === 1
          ? t("profiles.trash.moved", { name: recoverable[0].name })
          : t("profiles.trash.movedMany", { count: recoverable.length }),
        () => restoreFromTrash(recoverable.map((profile) => profile.id)),
      );
    },
    [restoreFromTrash, t],
  );

  const handleDeleteProfile = useCallback(
    async (profile: BrowserProfile) => {
      try {
        // First check if the browser is running for this profile
        const isRunning = await invoke<boolean>("check_browser_status", {
          profile,
        });

        if (isRunning) {
          showErrorToast(t("errors.cannotDeleteRunningProfile"));
          return;
        }

        await invoke("delete_profile", { profileId: profile.id });
        // useProfileEvents refreshes the list.
        announceTrashed([profile]);
      } catch (err: unknown) {
        console.error("Failed to delete profile:", err);
        showErrorToast(
          t("errors.deleteProfileFailed", {
            error: translateBackendError(t, err),
          }),
        );
      }
    },
    [announceTrashed, t],
  );

  const handleRenameProfile = useCallback(
    async (profileId: string, newName: string) => {
      try {
        await invoke("rename_profile", { profileId, newName });
        // No need to manually reload - useProfileEvents will handle the update
      } catch (err: unknown) {
        console.error("Failed to rename profile:", err);
        showErrorToast(
          t("errors.renameProfileFailed", {
            error: translateBackendError(t, err),
          }),
        );
        throw err;
      }
    },
    [t],
  );

  const handleKillProfile = useCallback(
    async (profile: BrowserProfile, opts?: { batch?: number }) => {
      console.log("Starting kill for profile:", profile.name);

      try {
        await invoke("kill_browser_profile", { profile });
        playUiSound("stop", { batch: opts?.batch });
        console.log("Successfully killed profile:", profile.name);
        // No need to manually reload - useProfileEvents will handle the update
      } catch (err: unknown) {
        console.error("Failed to kill browser:", err);
        showErrorToast(
          t("errors.killBrowserFailed", {
            error: translateBackendError(t, err),
          }),
        );
        // Re-throw the error so the table component can handle loading state cleanup
        throw err;
      }
    },
    [t],
  );

  const handleDeleteSelectedProfiles = useCallback(
    async (profileIds: string[]) => {
      const targets = profiles.filter((profile) =>
        profileIds.includes(profile.id),
      );
      try {
        await invoke("delete_selected_profiles", { profileIds });
        // useProfileEvents refreshes the list.
        announceTrashed(targets);
      } catch (err: unknown) {
        console.error("Failed to delete selected profiles:", err);
        showErrorToast(
          t("errors.deleteSelectedProfilesFailed", {
            error: translateBackendError(t, err),
          }),
        );
      }
    },
    [profiles, announceTrashed, t],
  );

  const handleAssignProfilesToGroup = useCallback((profileIds: string[]) => {
    setSelectedProfilesForGroup(profileIds);
    setGroupAssignmentDialogOpen(true);
  }, []);

  const handleDropProfilesToGroup = useCallback(
    async (profileIds: string[], groupId: string | null) => {
      const targets = profiles.filter((profile) =>
        profileIds.includes(profile.id),
      );
      if (
        targets.length !== profileIds.length ||
        targets.some(
          (profile) =>
            profile.process_id != null || runningProfiles.has(profile.id),
        ) ||
        (groupId !== null && !groupsData.some((group) => group.id === groupId))
      ) {
        showErrorToast(t("profileMotion.dragUnavailable"));
        return false;
      }
      try {
        await invoke("assign_profiles_to_group", { profileIds, groupId });
        setSelectedProfiles((selected) =>
          selected.filter((id) => !profileIds.includes(id)),
        );
        showSuccessToast(
          t("groups.assignSuccess", {
            count: profileIds.length,
            group:
              groupsData.find((group) => group.id === groupId)?.name ??
              t("groups.noGroup"),
          }),
          { sound: "drop" },
        );
        return true;
      } catch (error) {
        showErrorToast(translateBackendError(t, error));
        return false;
      } finally {
        // The backend can reject after writing an earlier member of the batch.
        // Refresh both views even on failure so counts and placement stay true.
        await Promise.allSettled([loadProfiles(), loadGroups()]);
      }
    },
    [profiles, runningProfiles, groupsData, loadProfiles, loadGroups, t],
  );

  const confirmBulkDelete = useCallback(async () => {
    if (selectedProfiles.length === 0) return;
    const targets = profiles.filter((profile) =>
      selectedProfiles.includes(profile.id),
    );

    setIsBulkDeleting(true);
    try {
      await invoke("delete_selected_profiles", {
        profileIds: selectedProfiles,
      });
      // useProfileEvents refreshes the list.
      setSelectedProfiles([]);
      setShowBulkDeleteConfirmation(false);
      announceTrashed(targets);
    } catch (error) {
      console.error("Failed to delete selected profiles:", error);
      showErrorToast(
        t("errors.deleteSelectedProfilesFailed", {
          error: translateBackendError(t, error),
        }),
      );
    } finally {
      setIsBulkDeleting(false);
    }
  }, [selectedProfiles, profiles, announceTrashed, t]);

  // To the trash at once, with Undo. Only an ephemeral profile, which is
  // destroyed for good, still asks first.
  const handleBulkDelete = useCallback(() => {
    if (selectedProfiles.length === 0) return;
    const permanent = profiles.some(
      (profile) => selectedProfiles.includes(profile.id) && profile.ephemeral,
    );
    if (permanent) {
      setShowBulkDeleteConfirmation(true);
      return;
    }
    void confirmBulkDelete();
  }, [selectedProfiles, profiles, confirmBulkDelete]);

  const handleBulkGroupAssignment = useCallback(() => {
    if (selectedProfiles.length === 0) return;
    handleAssignProfilesToGroup(selectedProfiles);
    setSelectedProfiles([]);
  }, [selectedProfiles, handleAssignProfilesToGroup]);

  const handleAssignExtensionGroup = useCallback((profileIds: string[]) => {
    setSelectedProfilesForExtensionGroup(profileIds);
    setExtensionGroupAssignmentDialogOpen(true);
  }, []);

  const handleBulkExtensionGroupAssignment = useCallback(() => {
    if (selectedProfiles.length === 0) return;
    handleAssignExtensionGroup(selectedProfiles);
    setSelectedProfiles([]);
  }, [selectedProfiles, handleAssignExtensionGroup]);

  const handleExtensionGroupAssignmentComplete = useCallback(() => {
    setExtensionGroupAssignmentDialogOpen(false);
    setSelectedProfilesForExtensionGroup([]);
  }, []);

  const handleAssignProfilesToProxy = useCallback((profileIds: string[]) => {
    setSelectedProfilesForProxy(profileIds);
    setProxyAssignmentDialogOpen(true);
  }, []);

  const handleBulkProxyAssignment = useCallback(() => {
    if (selectedProfiles.length === 0) return;
    handleAssignProfilesToProxy(selectedProfiles);
    setSelectedProfiles([]);
  }, [selectedProfiles, handleAssignProfilesToProxy]);

  const handleBulkProxyDistribution = useCallback(() => {
    if (selectedProfiles.length === 0) return;
    setSelectedProfilesForDistribution(selectedProfiles);
    setProxyDistributionDialogOpen(true);
  }, [selectedProfiles]);

  const handleBulkCopyCookies = useCallback(() => {
    if (selectedProfiles.length === 0) return;
    const eligibleProfiles = profiles.filter(
      (p) => selectedProfiles.includes(p.id) && p.browser === "wayfern",
    );
    if (eligibleProfiles.length === 0) {
      showErrorToast(t("errors.cookieCopyUnsupportedBrowser"));
      return;
    }
    setSelectedProfilesForCookies(eligibleProfiles.map((p) => p.id));
    setCookieCopyDialogOpen(true);
  }, [selectedProfiles, profiles, t]);

  const [pendingBulkAction, setPendingBulkAction] = useState<{
    action: "run" | "stop";
    profiles: BrowserProfile[];
  } | null>(null);
  const [isBulkActing, setIsBulkActing] = useState(false);

  // Set once the table filters exist: shows and selects the given profiles.
  const showProfilesRef = useRef<(profileIds: string[]) => void>(() => {});

  /**
   * Launch many profiles: at most `bulk_launch_concurrency` at a time, with
   * `bulk_launch_delay_ms` between starts, behind a progress toast whose
   * Cancel drops the launches not started yet. Failures are reported once,
   * in a summary that can show the failed profiles.
   */
  const executeBulkRun = useCallback(
    async (targets: BrowserProfile[]) => {
      setIsBulkActing(true);
      blanketGateDecisionRef.current = null;
      bulkRunIdRef.current += 1;
      const runId = bulkRunIdRef.current;
      const total = targets.length;
      const toastId = `bulk-launch-${runId}`;
      const startedAt = Date.now();
      let cancelled = false;
      let delayMs = 800;
      let concurrency = 3;
      try {
        const settings = await invoke<{
          bulk_launch_delay_ms?: number;
          bulk_launch_concurrency?: number;
        }>("get_app_settings");
        delayMs = Math.min(
          Math.max(settings.bulk_launch_delay_ms ?? delayMs, 0),
          60000,
        );
        concurrency = Math.min(
          Math.max(settings.bulk_launch_concurrency ?? concurrency, 1),
          20,
        );
      } catch (err) {
        console.warn("Bulk launch settings unavailable, using defaults:", err);
      }

      let started = 0;
      let done = 0;
      let declined = 0;
      const failed: BrowserProfile[] = [];
      const showProgress = () => {
        if (total < 2 || cancelled) return;
        showToast({
          id: toastId,
          type: "loading",
          title: t("profiles.bulkRun.progress", { done, total }),
          duration: Number.POSITIVE_INFINITY,
          onCancel: () => {
            cancelled = true;
            dismissToast(toastId);
          },
        });
      };

      let next = 0;
      let nextStartAt = 0;
      const worker = async () => {
        while (next < total && !cancelled) {
          const profile = targets[next];
          next += 1;
          // Starts are spaced across all workers, not per worker.
          const startAt = Math.max(Date.now(), nextStartAt);
          nextStartAt = startAt + delayMs;
          const wait = startAt - Date.now();
          if (wait > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, wait));
          }
          if (cancelled) return;
          started += 1;
          try {
            const result = await launchProfile(profile, {
              bulkRunId: runId,
              quiet: true,
            });
            if (result.status === "blocked") failed.push(profile);
            else if (result.status === "cancelled") declined += 1;
          } catch {
            failed.push(profile);
          }
          done += 1;
          showProgress();
        }
      };

      try {
        showProgress();
        await Promise.all(
          Array.from({ length: Math.min(concurrency, total) }, worker),
        );
      } finally {
        dismissToast(toastId);
        blanketGateDecisionRef.current = null;
        setIsBulkActing(false);
        setPendingBulkAction(null);
      }

      if (failed.length > 0) {
        const failedIds = failed.map((profile) => profile.id);
        const names = failed.slice(0, 3).map((profile) => profile.name);
        showErrorToast(
          t("profiles.bulkRun.failedSummary", {
            failed: failed.length,
            total,
          }),
          {
            id: `bulk-launch-failed-${runId}`,
            description:
              failed.length > names.length
                ? `${names.join(", ")}, …`
                : names.join(", "),
            action: {
              label: t("profiles.bulkRun.showFailed"),
              onClick: () => showProfilesRef.current(failedIds),
            },
          },
        );
      }
      if (declined > 0) {
        // A declined launch is no failure, but the person is told about it.
        showErrorToast(
          t("prelaunchGate.cancelledSummary", { cancelled: declined, total }),
        );
      }
      if (cancelled && started < total) {
        showToast({
          type: "info",
          title: t("profiles.bulkRun.notStarted", {
            count: total - started,
            total,
          }),
        });
      }
      if (Date.now() - startedAt >= 10_000) {
        void notifySystem({
          title: t("profiles.bulkRun.finishedTitle"),
          body: t("profiles.bulkRun.finishedBody", {
            launched: started - failed.length - declined,
            total,
          }),
        });
      }
    },
    [launchProfile, t],
  );

  const executeBulkStop = useCallback(
    async (targets: BrowserProfile[]) => {
      setIsBulkActing(true);
      const batch = performance.now();
      try {
        await Promise.allSettled(
          targets.map((p) => handleKillProfile(p, { batch })),
        );
      } finally {
        setIsBulkActing(false);
        setPendingBulkAction(null);
      }
    },
    [handleKillProfile],
  );

  const stopAllRunning = useCallback(() => {
    const targets = profiles.filter((p) => runningProfiles.has(p.id));
    if (targets.length === 0) {
      showToast({ type: "info", title: t("profiles.stopAll.none") });
      return;
    }
    void executeBulkStop(targets);
  }, [profiles, runningProfiles, executeBulkStop, t]);
  stopAllRunningRef.current = stopAllRunning;

  // A profile that runs, however it was started, has no launch error left.
  useEffect(() => {
    setLaunchErrors((current) => {
      const cleared = Object.keys(current).filter((id) =>
        runningProfiles.has(id),
      );
      if (cleared.length === 0) return current;
      const next = { ...current };
      for (const id of cleared) delete next[id];
      return next;
    });
  }, [runningProfiles]);

  // Bulk run/stop only touch eligible profiles (run: not already running;
  // stop: currently running). An empty result shows a toast instead of a silent
  // no-op (guard), and 10+ targets require confirmation before launching/stopping.
  const handleBulkRun = useCallback(() => {
    if (selectedProfiles.length === 0) return;
    const targets = profiles.filter(
      (p) => selectedProfiles.includes(p.id) && !runningProfiles.has(p.id),
    );
    if (targets.length === 0) {
      showErrorToast(t("profiles.bulkRun.noneToRun"));
      return;
    }
    if (targets.length >= 10) {
      setPendingBulkAction({ action: "run", profiles: targets });
      return;
    }
    void executeBulkRun(targets);
  }, [selectedProfiles, profiles, runningProfiles, executeBulkRun, t]);

  const handleBulkStop = useCallback(() => {
    if (selectedProfiles.length === 0) return;
    const targets = profiles.filter(
      (p) => selectedProfiles.includes(p.id) && runningProfiles.has(p.id),
    );
    if (targets.length === 0) {
      showErrorToast(t("profiles.bulkStop.noneToStop"));
      return;
    }
    if (targets.length >= 10) {
      setPendingBulkAction({ action: "stop", profiles: targets });
      return;
    }
    void executeBulkStop(targets);
  }, [selectedProfiles, profiles, runningProfiles, executeBulkStop, t]);

  const handleCopyCookiesToProfile = useCallback((profile: BrowserProfile) => {
    setSelectedProfilesForCookies([profile.id]);
    setCookieCopyDialogOpen(true);
  }, []);

  const handleOpenCookieManagement = useCallback((profile: BrowserProfile) => {
    setCurrentProfileForCookieManagement(profile);
    setCookieManagementDialogOpen(true);
  }, []);

  const handleGroupAssignmentComplete = useCallback(() => {
    // No need to manually reload - useProfileEvents will handle the update
    setGroupAssignmentDialogOpen(false);
    setSelectedProfilesForGroup([]);
  }, []);

  const handleProxyAssignmentComplete = useCallback(() => {
    // No need to manually reload - useProfileEvents will handle the update
    setProxyAssignmentDialogOpen(false);
    setSelectedProfilesForProxy([]);
  }, []);

  const handleGroupManagementComplete = useCallback(async () => {
    // No need to manually reload - useProfileEvents will handle the update
  }, []);

  const handleOpenProfileSyncDialog = useCallback((profile: BrowserProfile) => {
    setCurrentProfileForSync(profile);
    setProfileSyncDialogOpen(true);
  }, []);

  const handleToggleProfileSync = useCallback(
    async (profile: BrowserProfile) => {
      try {
        const enabling = !profile.sync_mode || profile.sync_mode === "Disabled";
        await invoke("set_profile_sync_mode", {
          profileId: profile.id,
          syncMode: enabling ? "Regular" : "Disabled",
        });
        showSuccessToast(
          t(enabling ? "sync.enabledToast" : "sync.disabledToast"),
          {
            description: t(
              enabling ? "sync.enabledDescription" : "sync.disabledDescription",
            ),
          },
        );
      } catch (error) {
        console.error("Failed to toggle sync:", error);
        showErrorToast(t("errors.updateSyncSettingsFailed"), {
          description: translateBackendError(t, error),
        });
      }
    },
    [t],
  );

  // The per-profile toggle, for every selected profile whose sync is off.
  const handleBulkEnableSync = useCallback(async () => {
    const targets = profiles.filter(
      (profile) =>
        selectedProfiles.includes(profile.id) &&
        !profile.ephemeral &&
        (!profile.sync_mode || profile.sync_mode === "Disabled"),
    );
    if (targets.length === 0) {
      showToast({ type: "info", title: t("sync.bulkEnableNone") });
      return;
    }
    const results = await Promise.allSettled(
      targets.map((profile) =>
        invoke("set_profile_sync_mode", {
          profileId: profile.id,
          syncMode: "Regular",
        }),
      ),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    const enabled = results.filter((r) => r.status === "fulfilled").length;
    if (enabled > 0) {
      showSuccessToast(t("sync.bulkEnabledToast", { count: enabled }), {
        description: t("sync.enabledDescription"),
      });
    }
    if (failure) {
      showErrorToast(t("errors.updateSyncSettingsFailed"), {
        description: translateBackendError(t, failure.reason),
      });
    }
  }, [profiles, selectedProfiles, t]);

  // A copy with the same settings and a new device, named by the backend.
  const handleDuplicateProfile = useCallback(
    async (profile: BrowserProfile) => {
      try {
        const copy = await invoke<BrowserProfile>("clone_profile", {
          profileId: profile.id,
          name: null,
        });
        showSuccessToast(t("profiles.duplicated", { name: copy.name }));
      } catch (error) {
        showErrorToast(
          t("errors.cloneProfileFailed", {
            error: translateBackendError(t, error),
          }),
        );
      }
    },
    [t],
  );

  const handleLockProfile = useCallback(
    async (profile: BrowserProfile) => {
      try {
        await invoke("lock_profile", { profileId: profile.id });
        showSuccessToast(t("profiles.lockedToast", { name: profile.name }));
      } catch (error) {
        showErrorToast(translateBackendError(t, error));
      }
    },
    [t],
  );

  // Open the profile on a leased host; the session stream reports the rest.
  const handleRunRemote = useCallback(
    async (profile: BrowserProfile) => {
      try {
        await startRemoteSession(profile.id);
        showSuccessToast(t("profiles.remote.starting", { name: profile.name }));
      } catch (error) {
        showErrorToast(translateBackendError(t, error));
      }
    },
    [t],
  );

  // The empty group's "Move profiles here": a picker of the other profiles.
  const [moveTargetGroup, setMoveTargetGroup] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const handleMoveProfilesHere = useCallback(() => {
    const group = groupsData.find((g) => g.id === selectedGroupId);
    if (group) setMoveTargetGroup({ id: group.id, name: group.name });
  }, [groupsData, selectedGroupId]);

  // Read through a ref so the sync listeners below subscribe once, and keep
  // which profiles are transferring across profile list reloads.
  const syncProfilesRef = useRef(profiles);
  syncProfilesRef.current = profiles;
  useEffect(() => {
    let disposed = false;
    let unlistenStatus: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    const profilesWithTransfer = new Set<string>();
    void (async () => {
      try {
        unlistenStatus = await listen<{
          profile_id: string;
          status: string;
          error?: string;
          profile_name?: string;
        }>("profile-sync-status", (event) => {
          const { profile_id, status, error, profile_name } = event.payload;
          const toastId = `sync-${profile_id}`;
          const profile = syncProfilesRef.current.find(
            (p) => p.id === profile_id,
          );
          const name =
            profile_name || profile?.name || t("common.labels.unknownProfile");

          if (status === "synced") {
            dismissToast(toastId);
            if (profilesWithTransfer.has(profile_id)) {
              profilesWithTransfer.delete(profile_id);
              showSuccessToast(t("sync.toast.profileSynced", { name }), {
                sound: "synced",
              });
            }
          } else if (status === "error") {
            dismissToast(toastId);
            profilesWithTransfer.delete(profile_id);
            showErrorToast(
              error
                ? t("sync.toast.profileSyncFailedWithError", { name, error })
                : t("sync.toast.profileSyncFailed", { name }),
            );
          }
        });

        unlistenProgress = await listen<{
          profile_id: string;
          phase: string;
          total_files?: number;
          total_bytes?: number;
          completed_files?: number;
          completed_bytes?: number;
          speed_bytes_per_sec?: number;
          eta_seconds?: number;
          failed_count?: number;
          profile_name?: string;
        }>("profile-sync-progress", (event) => {
          const payload = event.payload;
          const toastId = `sync-${payload.profile_id}`;
          const profile = syncProfilesRef.current.find(
            (p) => p.id === payload.profile_id,
          );
          const name =
            payload.profile_name ||
            profile?.name ||
            t("common.labels.unknownProfile");

          if (
            payload.phase === "started" ||
            payload.phase === "uploading" ||
            payload.phase === "downloading"
          ) {
            profilesWithTransfer.add(payload.profile_id);
            showSyncProgressToast(
              name,
              {
                completed_files: payload.completed_files ?? 0,
                total_files: payload.total_files ?? 0,
                completed_bytes: payload.completed_bytes ?? 0,
                total_bytes: payload.total_bytes ?? 0,
                speed_bytes_per_sec: payload.speed_bytes_per_sec ?? 0,
                eta_seconds: payload.eta_seconds ?? 0,
                failed_count: payload.failed_count ?? 0,
                phase: payload.phase,
              },
              { id: toastId, profileId: payload.profile_id },
            );
          }
        });
        // If the effect was torn down while we were awaiting the listeners,
        // unlisten immediately — the cleanup below already ran and would have
        // missed these handles. (Tauri unlisten is safe to call more than once.)
        if (disposed) {
          unlistenStatus?.();
          unlistenProgress?.();
        }
      } catch (error) {
        console.error("Failed to listen for sync events:", error);
      }
    })();
    return () => {
      disposed = true;
      if (unlistenStatus) unlistenStatus();
      if (unlistenProgress) unlistenProgress();
    };
  }, [t]);

  useEffect(() => {
    // Listen for URL open events. Guard against the effect tearing down (or
    // re-running) before the async listener setup resolves: if that happens,
    // run the cleanup as soon as it's available so the listeners never leak.
    let cleanup: (() => void) | undefined;
    let disposed = false;
    void listenForUrlEvents().then((cleanupFn) => {
      if (disposed) {
        cleanupFn?.();
        return;
      }
      cleanup = cleanupFn;
    });

    // Check for startup URLs (when app was launched as default browser)
    void checkCurrentUrl();

    // Set up periodic update checks (every 30 minutes)
    const updateInterval = setInterval(
      () => {
        void checkForUpdates();
      },
      30 * 60 * 1000,
    );

    // Check for missing binaries after initial profile load
    if (!profilesLoading && profiles.length > 0) {
      void checkMissingBinaries();
    }

    // Proactively download Wayfern if not already available
    if (!profilesLoading) {
      void invoke("ensure_active_browsers_downloaded").catch((err: unknown) => {
        console.error("Failed to auto-download browsers:", err);
      });
    }

    return () => {
      disposed = true;
      clearInterval(updateInterval);
      cleanup?.();
    };
  }, [
    checkForUpdates,
    listenForUrlEvents,
    checkCurrentUrl,
    checkMissingBinaries,
    profilesLoading,
    profiles.length,
  ]);

  // E2E encryption listeners — surface password-required prompts and rollover
  // progress so the user isn't left guessing whether sealing finished.
  useEffect(() => {
    let disposed = false;
    let unlistenRequired: (() => void) | undefined;
    let unlistenStarted: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    let unlistenCompleted: (() => void) | undefined;
    let unlistenWayfernBlocked: (() => void) | undefined;
    let unlistenGenerationLimit: (() => void) | undefined;

    void (async () => {
      unlistenRequired = await listen(
        "profile-sync-e2e-password-required",
        () => {
          showToast({
            id: "e2e-password-required",
            type: "error",
            title: t("encryption.required.title"),
            description: t("encryption.required.description"),
            duration: 12000,
            action: {
              label: t("encryption.required.openSettings"),
              onClick: () => {
                handleRailNavigate("settings");
              },
            },
          });
        },
      );

      unlistenStarted = await listen("e2e-rollover-started", () => {
        showToast({
          id: "e2e-rollover",
          type: "loading",
          title: t("encryption.rollover.startedTitle"),
          description: t("encryption.rollover.startedDescription"),
          duration: Number.POSITIVE_INFINITY,
        });
      });

      unlistenProgress = await listen<{
        stage: string;
        done: number;
        total: number;
      }>("e2e-rollover-progress", (event) => {
        const { stage, done, total } = event.payload;
        showToast({
          id: "e2e-rollover",
          type: "loading",
          title: t("encryption.rollover.progressTitle", {
            stage: t(`encryption.rollover.stage.${stage}`),
          }),
          description: t("encryption.rollover.progressDescription", {
            done,
            total,
          }),
          duration: Number.POSITIVE_INFINITY,
        });
      });

      unlistenCompleted = await listen("e2e-rollover-completed", () => {
        showToast({
          id: "e2e-rollover",
          type: "success",
          title: t("encryption.rollover.completedTitle"),
          description: t("encryption.rollover.completedDescription"),
          duration: 5000,
        });
      });

      unlistenGenerationLimit = await listen(
        "profile-generation-limit-reached",
        () => {
          showToast({
            id: "profile-generation-limit-reached",
            type: "error",
            title: t("profileGenerationLimit.title"),
            description: t("profileGenerationLimit.description"),
            duration: 15000,
          });
        },
      );

      unlistenWayfernBlocked = await listen("wayfern-paid-blocked", () => {
        showToast({
          id: "wayfern-paid-blocked",
          type: "error",
          title: t("wayfernBlocked.title"),
          description: t("wayfernBlocked.description"),
          duration: 15000,
        });
      });

      // If the effect was torn down mid-setup, the cleanup below already ran
      // before these handles existed — unlisten them now so nothing leaks.
      if (disposed) {
        unlistenRequired?.();
        unlistenStarted?.();
        unlistenProgress?.();
        unlistenCompleted?.();
        unlistenWayfernBlocked?.();
        unlistenGenerationLimit?.();
      }
    })();

    return () => {
      disposed = true;
      unlistenRequired?.();
      unlistenStarted?.();
      unlistenProgress?.();
      unlistenCompleted?.();
      unlistenWayfernBlocked?.();
      unlistenGenerationLimit?.();
    };
  }, [t, handleRailNavigate]);

  // Re-check Wayfern terms when a browser download completes
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    const setup = async () => {
      unlisten = await listen<{ stage: string }>(
        "download-progress",
        (event) => {
          if (event.payload.stage === "completed") {
            void checkTerms();
          }
        },
      );
    };
    void setup();
    return () => {
      if (unlisten) unlisten();
    };
  }, [checkTerms]);

  // Check permissions when they are initialized. During first-run onboarding
  // the welcome flow requests permissions, so the standalone dialog is deferred
  // until we know this isn't a first-run onboarding.
  useEffect(() => {
    if (isInitialized && firstRunOnboarding === false) {
      checkAllPermissions();
    }
  }, [isInitialized, firstRunOnboarding, checkAllPermissions]);

  // Check self-hosted sync config on mount, when cloud user changes, and when
  // a signed-in device picks where it syncs.
  useEffect(() => {
    void checkSelfHostedSync();
    const unlisten = listen("sync-source-changed", () => {
      void checkSelfHostedSync();
    });
    return () => {
      void unlisten.then((stop) => {
        stop();
      });
    };
  }, [checkSelfHostedSync]);

  // The tray menu acts through the same handlers as the window. The latest
  // handlers and lists are read through a ref, so one listener serves all.
  const trayRef = useRef({
    profiles,
    runningProfiles,
    launchProfile,
    handleKillProfile,
    stopAllRunning,
    goToProfilesThen,
  });
  trayRef.current = {
    profiles,
    runningProfiles,
    launchProfile,
    handleKillProfile,
    stopAllRunning,
    goToProfilesThen,
  };
  useEffect(() => {
    // The backend brings the window forward itself for Show, Open and a
    // launch that asks for a password; a plain launch or stop stays behind.
    const unlisten = listen<{
      action:
        | "show"
        | "stop-all"
        | "stop-profile"
        | "launch-profile"
        | "open-profile";
      profile_id?: string;
    }>("tray-action", (event) => {
      const tray = trayRef.current;
      const { action, profile_id } = event.payload;
      const profile = profile_id
        ? tray.profiles.find((p) => p.id === profile_id)
        : undefined;
      switch (action) {
        case "show":
          break;
        case "stop-all":
          tray.stopAllRunning();
          break;
        case "stop-profile":
          if (profile && tray.runningProfiles.has(profile.id)) {
            void tray.handleKillProfile(profile).catch(() => {});
          }
          break;
        case "launch-profile":
          if (profile && !tray.runningProfiles.has(profile.id)) {
            void tray.launchProfile(profile).catch(() => {});
          }
          break;
        case "open-profile":
          if (profile) {
            tray.goToProfilesThen(() => {
              setProfileInfoOpenMethod("pointer");
              setProfileInfoDialog(profile);
            });
          }
          break;
      }
    });
    return () => {
      void unlisten.then((stop) => {
        stop();
      });
    };
  }, []);

  // Profiles that were running when the app last quit open again, through
  // the bulk launch path, once the list is loaded and launches are allowed.
  const reopenCheckedRef = useRef(false);
  useEffect(() => {
    if (reopenCheckedRef.current) return;
    if (profilesLoading || termsAccepted !== true) return;
    reopenCheckedRef.current = true;
    void invoke<string[]>("take_reopen_profiles")
      .then((ids) => {
        const targets = trayRef.current.profiles.filter(
          (profile) =>
            ids.includes(profile.id) &&
            !trayRef.current.runningProfiles.has(profile.id),
        );
        if (targets.length > 0) void executeBulkRun(targets);
      })
      .catch(() => {
        // An older backend has no such command; nothing to reopen then.
      });
  }, [profilesLoading, termsAccepted, executeBulkRun]);

  // A profile stores ids, and the query asks about names, so the matcher is
  // handed the resolution up front. Built off the entity lists rather than off
  // `profiles`, because the alternative — a .find() per row per term — is
  // O(profiles x entities) on every single keystroke.
  const searchContext = useMemo<ProfileSearchContext>(
    () => ({
      groupNames: new Map(groupsData.map((g) => [g.id, g.name])),
      proxyNames: new Map(storedProxies.map((p) => [p.id, p.name])),
      vpnNames: new Map(vpnConfigs.map((v) => [v.id, v.name])),
      extensionGroupNames: new Map(extensionGroups.map((e) => [e.id, e.name])),
      statusNames: new Map(profileStatuses.map((s) => [s.id, s.name])),
      runningProfiles,
    }),
    [
      groupsData,
      storedProxies,
      vpnConfigs,
      extensionGroups,
      profileStatuses,
      runningProfiles,
    ],
  );

  const profilesInGroup = useMemo(
    () =>
      !selectedGroupId || selectedGroupId === "__all__"
        ? profiles
        : profiles.filter((profile) => profile.group_id === selectedGroupId),
    [profiles, selectedGroupId],
  );
  const profileFilters = useProfileTableFilters(
    profilesInGroup,
    searchQuery,
    searchContext,
  );
  const changeProfileSearch = (query: string) => {
    setSearchQuery(query);
  };
  const clearProfileFilters = () => {
    profileFilters.reset();
    setSearchQuery("");
  };
  // The bulk launch summary's "Show": every filter off, then the failed
  // profiles selected, so they are all on screen together.
  showProfilesRef.current = (profileIds: string[]) => {
    goToProfilesThen(() => {
      setSelectedGroupId("__all__");
      profileFilters.reset();
      setSearchQuery("");
      setSelectedProfiles(
        profileIds.filter((id) => profiles.some((p) => p.id === id)),
      );
    });
  };

  // Update loading states
  const isLoading = profilesLoading || groupsLoading || proxiesLoading;

  const subPageTitle =
    currentPage === "profiles"
      ? undefined
      : currentPage === "import"
        ? t("pageTitle.import")
        : t(`pageTitle.${currentPage}`);
  // Proxies and VPNs are one page with two tabs: switching tabs is no move.
  const transitionKey = currentPage === "vpns" ? "proxies" : currentPage;

  return (
    <ProfileGroupDragProvider
      enabled={currentPage === "profiles"}
      onAssign={handleDropProfilesToGroup}
    >
      <div className="flex h-dvh flex-col bg-background font-(family-name:--font-geist-sans)">
        <CloseConfirmDialog />
        <HomeHeader
          onCreateProfileDialogOpen={(open) =>
            open ? openCreateProfile() : setCreateProfileDialogOpen(false)
          }
          canCreateProfiles={!teamReadOnly}
          searchQuery={searchQuery}
          onSearchQueryChange={changeProfileSearch}
          searchProfiles={profilesInGroup}
          searchContext={searchContext}
          groups={groupsData}
          totalProfiles={profiles.length}
          selectedGroupId={selectedGroupId}
          onGroupSelect={handleSelectGroup}
          pageTitle={subPageTitle}
          page={currentPage}
          pageDirection={pageMove.dir}
        />
        <div className="flex min-h-0 flex-1">
          <RailNav
            currentPage={currentPage}
            onNavigate={handleRailNavigate}
            onOpenAbout={() => {
              setAboutDialogOpen(true);
            }}
            onOpenTips={() => openTips()}
            onOpenFeedback={() => {
              setFeedbackDialogOpen(true);
            }}
            cookieBotRunning={Object.keys(cookieBotLiveSessions).length > 0}
            agentRequests={agentConsole.openRequests.length}
          />
          <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            <PageTransition
              pageKey={transitionKey}
              direction={pageMove.dir}
              className="flex min-h-0 flex-1 flex-col"
            >
              {currentPage === "profiles" && (
                <div
                  data-table-id="profiles"
                  className="flex min-h-0 flex-1 flex-col px-3 pt-2.5"
                >
                  <SynchronizerPanel
                    sessions={syncSessions}
                    onSessionChanged={applySession}
                  />
                  <AutoHeight deps={[teamReadOnly]} className="shrink-0">
                    {teamReadOnly && (
                      <p
                        className="mb-2 rounded-md bg-foreground/5 px-3 py-2 text-xs text-muted-foreground"
                        data-testid="team-read-only-notice"
                      >
                        {t("teamRoles.readOnlyNotice")}
                      </p>
                    )}
                  </AutoHeight>
                  <ProfilesDataTable
                    profileStatuses={profileStatuses}
                    isLoading={isLoading && profiles.length === 0}
                    showOnboardingEmptyState={profiles.length === 0}
                    profiles={profileFilters.rows}
                    filterControls={
                      <TableFilterControls
                        {...profileFilters}
                        query={searchQuery}
                        onQueryChange={changeProfileSearch}
                        showSearch={false}
                        count={profileFilters.rows.length}
                        total={profilesInGroup.length}
                        onReset={clearProfileFilters}
                      />
                    }
                    onClearFilters={clearProfileFilters}
                    allProfiles={profiles}
                    infoDialogProfile={profileInfoDialog}
                    infoOpenMethod={profileInfoOpenMethod}
                    onInfoOpenMethodChange={setProfileInfoOpenMethod}
                    onInfoDialogProfileChange={setProfileInfoDialog}
                    onLaunchProfile={launchProfile}
                    onKillProfile={handleKillProfile}
                    onCloneProfile={handleCloneProfile}
                    onSetPassword={handleSetPassword}
                    onChangePassword={handleChangePassword}
                    onRemovePassword={handleRemovePassword}
                    onDeleteProfile={handleDeleteProfile}
                    onRenameProfile={handleRenameProfile}
                    onConfigureWayfern={handleConfigureWayfern}
                    onCopyCookiesToProfile={handleCopyCookiesToProfile}
                    onOpenCookieManagement={handleOpenCookieManagement}
                    runningProfiles={runningProfiles}
                    extensionGroups={extensionGroups}
                    isUpdating={isUpdating}
                    onDeleteSelectedProfiles={handleDeleteSelectedProfiles}
                    onAssignProfilesToGroup={handleAssignProfilesToGroup}
                    onAssignProfilesToProxy={handleAssignProfilesToProxy}
                    selectedGroupId={selectedGroupId}
                    selectedProfiles={selectedProfiles}
                    onSelectedProfilesChange={setSelectedProfiles}
                    onBulkDelete={handleBulkDelete}
                    onBulkGroupAssignment={handleBulkGroupAssignment}
                    onBulkProxyAssignment={handleBulkProxyAssignment}
                    onBulkProxyDistribution={handleBulkProxyDistribution}
                    onBulkCopyCookies={handleBulkCopyCookies}
                    onBulkRun={handleBulkRun}
                    onBulkStop={handleBulkStop}
                    bulkActionsUnlocked={automationUnlocked}
                    onBulkExtensionGroupAssignment={
                      handleBulkExtensionGroupAssignment
                    }
                    onAssignExtensionGroup={handleAssignExtensionGroup}
                    onOpenProfileSyncDialog={handleOpenProfileSyncDialog}
                    onToggleProfileSync={handleToggleProfileSync}
                    crossOsUnlocked={crossOsUnlocked}
                    syncUnlocked={syncUnlocked}
                    getProfileSyncInfo={getProfileSyncInfo}
                    onLaunchWithSync={(profile) => {
                      setSyncLeaderProfile(profile);
                    }}
                    onCreateProfile={openCreateProfile}
                    onImportProfiles={() => {
                      handleRailNavigate("import");
                    }}
                    launchErrors={launchErrors}
                    onCreateProfileInGroup={openCreateProfile}
                    onMoveProfilesHere={handleMoveProfilesHere}
                    onBulkEnableSync={() => void handleBulkEnableSync()}
                    onDuplicateProfile={(profile) =>
                      void handleDuplicateProfile(profile)
                    }
                    onLockProfile={(profile) => void handleLockProfile(profile)}
                    onRunRemote={(profile) => void handleRunRemote(profile)}
                  />
                  <TipCoachMark
                    flow={tipsFlow}
                    page={currentPage}
                    onAction={runTipAction}
                  />
                </div>
              )}

              {currentPage === "shortcuts" && (
                <div className="flex min-h-0 flex-1 flex-col">
                  <ShortcutsPage
                    groupTargets={orderedGroupTargets}
                    onOpenPalette={() => {
                      setCommandPaletteOpen(true);
                    }}
                  />
                </div>
              )}

              {settingsDialogOpen && (
                <SettingsDialog
                  isOpen={settingsDialogOpen}
                  onClose={() => {
                    closeSubPage(() => setSettingsDialogOpen(false));
                  }}
                  onIntegrationsOpen={() => {
                    handleRailNavigate("integrations");
                  }}
                  subPage={currentPage === "settings"}
                  initialSection={settingsInitialSection}
                />
              )}

              {integrationsDialogOpen && (
                <IntegrationsDialog
                  isOpen={integrationsDialogOpen}
                  onClose={() => {
                    closeSubPage(() => setIntegrationsDialogOpen(false));
                  }}
                  subPage={currentPage === "integrations"}
                  initialTab={integrationsInitialTab}
                />
              )}

              {proxyManagementDialogOpen && (
                <ProxyManagementDialog
                  isOpen={proxyManagementDialogOpen}
                  onClose={() => {
                    closeSubPage(() => setProxyManagementDialogOpen(false));
                  }}
                  subPage={currentPage === "proxies" || currentPage === "vpns"}
                  initialTab={proxyManagementInitialTab}
                />
              )}

              {groupManagementDialogOpen && (
                <GroupManagementDialog
                  isOpen={groupManagementDialogOpen}
                  onClose={() => {
                    closeSubPage(() => setGroupManagementDialogOpen(false));
                  }}
                  onGroupManagementComplete={handleGroupManagementComplete}
                  subPage={currentPage === "groups"}
                />
              )}

              {extensionManagementDialogOpen && (
                <ExtensionManagementDialog
                  isOpen={extensionManagementDialogOpen}
                  onClose={() => {
                    closeSubPage(() => setExtensionManagementDialogOpen(false));
                  }}
                  limitedMode={false}
                  subPage={currentPage === "extensions"}
                  initialTab={extensionManagementInitialTab}
                />
              )}

              {importProfileDialogOpen && (
                <ImportProfileDialog
                  isOpen={importProfileDialogOpen}
                  onClose={() => {
                    closeSubPage(() => setImportProfileDialogOpen(false));
                  }}
                  crossOsUnlocked={crossOsUnlocked}
                  subPage={currentPage === "import"}
                />
              )}

              {cookieBotDialogOpen && (
                <CookieBotPage
                  isOpen={cookieBotDialogOpen}
                  onClose={() => {
                    closeSubPage(() => setCookieBotDialogOpen(false));
                  }}
                  subPage={currentPage === "cookieBot"}
                  initialTab={cookieBotInitialTab}
                  profiles={profiles}
                  cloudUser={cloudUser}
                  onOpenProfileSync={handleOpenProfileSyncDialog}
                  onAssignProxy={handleAssignProfilesToProxy}
                />
              )}

              {agentDialogOpen && (
                <AgentPage
                  isOpen={agentDialogOpen}
                  onClose={() => {
                    closeSubPage(() => setAgentDialogOpen(false));
                  }}
                  subPage={currentPage === "agent"}
                  initialTab={agentInitialTab}
                  onTabChange={setAgentInitialTab}
                  profiles={profiles}
                  cloudUser={cloudUser}
                  agentConsole={agentConsole}
                  onConnectAgent={() => {
                    setIntegrationsInitialTab("remote");
                    handleRailNavigate("integrations");
                  }}
                  onOpenAccount={() => {
                    handleRailNavigate("account");
                  }}
                />
              )}

              {accountDialogOpen && (
                <AccountPage
                  isOpen={accountDialogOpen}
                  onClose={() => {
                    closeSubPage(() => setAccountDialogOpen(false));
                  }}
                  subPage={currentPage === "account"}
                  onOpenSignIn={() => {
                    closeSubPage(() => {
                      setAccountDialogOpen(false);
                      setDeviceCodeDialogOpen(true);
                    });
                  }}
                />
              )}

              {trashPageOpen && (
                <TrashPage
                  isOpen={trashPageOpen}
                  onClose={() => {
                    closeSubPage(() => setTrashPageOpen(false));
                  }}
                  subPage={currentPage === "trash"}
                />
              )}
            </PageTransition>

            {/* A modal, so it stays out of the page transition: a page that
                fades out must not take a second copy of it along. */}
            <TotpToolDialog
              isOpen={totpToolOpen}
              onClose={() => setTotpToolOpen(false)}
            />
          </main>
        </div>

        <CreateProfileDialog
          isOpen={createProfileDialogOpen}
          onClose={() => {
            setCreateProfileDialogOpen(false);
          }}
          onCreateProfile={handleCreateProfile}
          selectedGroupId={selectedGroupId}
          crossOsUnlocked={crossOsUnlocked}
        />

        <CommandPalette
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
          onAction={runShortcut}
          groupTargets={orderedGroupTargets}
          onSelectGroup={(id) => {
            goToProfilesThen(() => handleSelectGroup(id));
          }}
          profiles={profiles}
          runningProfileIds={runningProfiles}
          onLaunchProfile={(profile) => {
            void launchProfile(profile);
          }}
          onKillProfile={(profile) => {
            void handleKillProfile(profile);
          }}
          onShowProfileInfo={(profile) => {
            goToProfilesThen(() => {
              setProfileInfoOpenMethod("keyboard");
              setProfileInfoDialog(profile);
            });
          }}
          onCreateProfile={openCreateProfile}
          onOpenAbout={() => {
            setAboutDialogOpen(true);
          }}
        />

        <LeavePromptDialog />

        <MoveProfilesDialog
          group={moveTargetGroup}
          onClose={() => setMoveTargetGroup(null)}
          profiles={profiles}
          runningProfiles={runningProfiles}
          onMove={handleDropProfilesToGroup}
        />

        <AboutDialog
          isOpen={aboutDialogOpen}
          onClose={() => {
            setAboutDialogOpen(false);
          }}
          update={appUpdate}
          onOpenFeedback={() => {
            setAboutDialogOpen(false);
            setFeedbackDialogOpen(true);
          }}
          onOpenShortcuts={() => {
            setAboutDialogOpen(false);
            handleRailNavigate("shortcuts");
          }}
        />

        <FeedbackDialog
          isOpen={feedbackDialogOpen}
          onClose={() => {
            setFeedbackDialogOpen(false);
          }}
          accountEmail={cloudUser?.email ?? null}
        />

        <PreLaunchGateDialog
          isOpen={gateState !== null}
          profileName={gateState?.req.profile.name ?? ""}
          profileId={gateState?.req.profile.id ?? ""}
          requestId={gateState?.id ?? 0}
          findings={gateState?.req.findings ?? null}
          remainingCount={gateState?.remaining ?? 0}
          onResult={settleGate}
        />

        {pendingUrls.map((pendingUrl) => (
          <ProfileSelectorDialog
            key={pendingUrl.id}
            isOpen={true}
            onClose={() => {
              setPendingUrls((prev) =>
                prev.filter((u) => u.id !== pendingUrl.id),
              );
            }}
            url={pendingUrl.url}
            isUpdating={isUpdating}
            runningProfiles={runningProfiles}
          />
        ))}

        <PermissionDialog
          isOpen={permissionDialogOpen}
          onClose={() => {
            setPermissionDialogOpen(false);
          }}
          permissionType={currentPermissionType}
          onPermissionGranted={checkNextPermission}
        />

        <WelcomeDialog
          isOpen={welcomeOpen}
          needsSetup={profiles.length === 0}
          onComplete={handleWelcomeComplete}
        />
        <OnboardingTour
          open={tour.open}
          step={tour.step}
          onSkip={skipTour}
          onFinish={finishTour}
        />
        <ThankYouDialog
          isOpen={thankYouOpen}
          onClose={() => setThankYouOpen(false)}
        />
        <TipsDialog
          key={tipsFlow.dialog.session}
          open={tipsFlow.dialog.open}
          tips={tipsFlow.tips}
          seen={tipsFlow.seen}
          initialTipId={tipsFlow.dialog.initialTipId}
          autoShow={tipsFlow.autoShow}
          onOpenChange={(open) => {
            if (!open) closeTips();
          }}
          onTipShown={tipsFlow.markSeen}
          onAutoShowChange={(enabled) => void tipsFlow.setAutoShow(enabled)}
          onAction={runTipAction}
          onShowMe={(id) => {
            goToProfilesThen(() => tipsFlow.showOnPage(id));
          }}
        />
        <PaidWelcomeDialog
          open={tipsFlow.paidWelcome.open}
          plan={tipsFlow.paidWelcome.plan}
          tips={tipsFlow.planTips}
          onOpenChange={(open) => {
            if (!open) tipsFlow.dismissPaidWelcome();
          }}
          onOpenTip={(id) => {
            tipsFlow.dismissPaidWelcome();
            openTips(id);
          }}
        />

        <CloneProfileDialog
          isOpen={!!cloneProfile}
          onClose={() => {
            setCloneProfile(null);
          }}
          profile={cloneProfile}
        />

        <ProfilePasswordDialog
          isOpen={!!passwordDialogProfile}
          onClose={() => {
            pendingLaunchAfterUnlockRef.current = null;
            setPasswordDialogProfile(null);
          }}
          profile={passwordDialogProfile}
          mode={passwordDialogMode}
          onSuccess={(p) => {
            // Resume pending launch after unlock.
            if (
              passwordDialogMode === "unlock" &&
              pendingLaunchAfterUnlockRef.current?.id === p.id
            ) {
              const target = pendingLaunchAfterUnlockRef.current;
              pendingLaunchAfterUnlockRef.current = null;
              void launchProfile(target);
            }
            // On set/change/remove, the profile's encryption state changed.
            // Push that state to the sync server immediately so other devices
            // see the new envelope before they next pull. Skip if the profile
            // is currently running — its files would be in flux.
            if (
              (passwordDialogMode === "set" ||
                passwordDialogMode === "change" ||
                passwordDialogMode === "remove") &&
              !runningProfiles.has(p.id) &&
              p.sync_mode !== "Disabled"
            ) {
              void invoke("request_profile_sync", { profileId: p.id }).catch(
                (err: unknown) => {
                  console.error("post-password sync failed", err);
                },
              );
            }
          }}
        />

        <WayfernConfigDialog
          isOpen={wayfernConfigDialogOpen}
          onClose={() => {
            setWayfernConfigDialogOpen(false);
          }}
          profile={currentProfileForWayfernConfig}
          onSave={handleSaveWayfernConfig}
          isRunning={
            currentProfileForWayfernConfig
              ? runningProfiles.has(currentProfileForWayfernConfig.id)
              : false
          }
          crossOsUnlocked={crossOsUnlocked}
        />

        <GroupAssignmentDialog
          isOpen={groupAssignmentDialogOpen}
          onClose={() => {
            setGroupAssignmentDialogOpen(false);
          }}
          selectedProfiles={selectedProfilesForGroup}
          onAssignmentComplete={handleGroupAssignmentComplete}
          profiles={profiles}
        />

        <ExtensionGroupAssignmentDialog
          isOpen={extensionGroupAssignmentDialogOpen}
          onClose={() => {
            setExtensionGroupAssignmentDialogOpen(false);
          }}
          selectedProfiles={selectedProfilesForExtensionGroup}
          onAssignmentComplete={handleExtensionGroupAssignmentComplete}
          profiles={profiles}
        />

        <ProxyAssignmentDialog
          isOpen={proxyAssignmentDialogOpen}
          onClose={() => {
            setProxyAssignmentDialogOpen(false);
          }}
          selectedProfiles={selectedProfilesForProxy}
          onAssignmentComplete={handleProxyAssignmentComplete}
          profiles={profiles}
          storedProxies={storedProxies}
          vpnConfigs={vpnConfigs}
        />

        <ProxyDistributionDialog
          isOpen={proxyDistributionDialogOpen}
          onClose={() => {
            setProxyDistributionDialogOpen(false);
          }}
          selectedProfiles={selectedProfilesForDistribution}
          profiles={profiles}
          storedProxies={storedProxies}
          onDistributionComplete={() => {
            // useProfileEvents refreshes the table; only the selection needs
            // clearing, and only once the assignments actually landed.
            setSelectedProfiles([]);
          }}
        />

        <CookieCopyDialog
          isOpen={cookieCopyDialogOpen}
          onClose={() => {
            setCookieCopyDialogOpen(false);
            setSelectedProfilesForCookies([]);
          }}
          selectedProfiles={selectedProfilesForCookies}
          profiles={profiles}
          runningProfiles={runningProfiles}
          onCopyComplete={() => {
            setSelectedProfilesForCookies([]);
          }}
        />

        <CookieManagementDialog
          isOpen={cookieManagementDialogOpen}
          onClose={() => {
            setCookieManagementDialogOpen(false);
            setCurrentProfileForCookieManagement(null);
          }}
          profile={currentProfileForCookieManagement}
        />

        <DeleteConfirmationDialog
          isOpen={pendingBulkAction !== null}
          onClose={() => {
            setPendingBulkAction(null);
          }}
          onConfirm={() => {
            if (!pendingBulkAction) return;
            if (pendingBulkAction.action === "run") {
              void executeBulkRun(pendingBulkAction.profiles);
            } else {
              void executeBulkStop(pendingBulkAction.profiles);
            }
          }}
          title={
            pendingBulkAction?.action === "stop"
              ? t("profiles.bulkStop.confirmTitle", {
                  count: pendingBulkAction?.profiles.length ?? 0,
                })
              : t("profiles.bulkRun.confirmTitle", {
                  count: pendingBulkAction?.profiles.length ?? 0,
                })
          }
          description={
            pendingBulkAction?.action === "stop"
              ? t("profiles.bulkStop.confirmDescription", {
                  count: pendingBulkAction?.profiles.length ?? 0,
                })
              : t("profiles.bulkRun.confirmDescription", {
                  count: pendingBulkAction?.profiles.length ?? 0,
                })
          }
          confirmButtonText={
            pendingBulkAction?.action === "stop"
              ? t("profiles.bulkStop.confirmButton", {
                  count: pendingBulkAction?.profiles.length ?? 0,
                })
              : t("profiles.bulkRun.confirmButton", {
                  count: pendingBulkAction?.profiles.length ?? 0,
                })
          }
          confirmButtonVariant="default"
          isLoading={isBulkActing}
        />
        <DeleteConfirmationDialog
          isOpen={showBulkDeleteConfirmation}
          onClose={() => {
            setShowBulkDeleteConfirmation(false);
          }}
          onConfirm={confirmBulkDelete}
          title={t("profiles.bulkDelete.title")}
          description={t("profiles.bulkDelete.description", {
            count: selectedProfiles.length,
          })}
          confirmButtonText={t("profiles.bulkDelete.confirmButton", {
            count: selectedProfiles.length,
          })}
          isLoading={isBulkDeleting}
          profileIds={selectedProfiles}
          profiles={profiles.map((p) => ({ id: p.id, name: p.name }))}
        />

        <SyncConfigDialog
          isOpen={syncConfigDialogOpen}
          onClose={(loginOccurred) => {
            setSyncConfigDialogOpen(false);
            void checkSelfHostedSync();
            if (loginOccurred) {
              setSyncAllDialogOpen(true);
            }
          }}
          onLoginStarted={() => {
            // Hand the verify step off to its own dialog. We close this one
            // first so the verify dialog isn't stacked on top of it (and
            // can't end up stacked on top of the profile selector either).
            setSyncConfigDialogOpen(false);
            setDeviceCodeDialogOpen(true);
          }}
        />

        {/* Only render while no profile-selector flow is in progress, so the
          verify dialog never lands on top of a deep-link-triggered selector. */}
        {pendingUrls.length === 0 && (
          <DeviceCodeVerifyDialog
            isOpen={deviceCodeDialogOpen}
            onClose={(loginOccurred) => {
              setDeviceCodeDialogOpen(false);
              if (loginOccurred) {
                setSyncAllDialogOpen(true);
              }
            }}
          />
        )}

        <SyncAllDialog
          isOpen={syncAllDialogOpen}
          onClose={() => {
            setSyncAllDialogOpen(false);
          }}
        />

        <ProfileSyncDialog
          isOpen={profileSyncDialogOpen}
          onClose={() => {
            setProfileSyncDialogOpen(false);
            setCurrentProfileForSync(null);
          }}
          profile={currentProfileForSync}
          onSyncConfigOpen={() => {
            setSyncConfigDialogOpen(true);
          }}
        />

        {/* Wayfern Terms and Conditions Dialog - shown if terms not accepted */}
        <WayfernTermsDialog
          isOpen={!termsLoading && termsAccepted === false}
          onAccepted={checkTerms}
        />

        {/* Commercial Trial Modal - shown once when trial expires (skip for paid users) */}
        <CommercialTrialModal
          isOpen={commercialTrialModalOpen}
          onClose={checkTrialStatus}
        />

        <WindowResizeWarningDialog
          isOpen={windowResizeWarningOpen}
          onResult={(proceed) => {
            setWindowResizeWarningOpen(false);
            windowResizeWarningResolver.current?.(proceed);
            windowResizeWarningResolver.current = null;
          }}
        />

        <SyncFollowerDialog
          isOpen={syncLeaderProfile !== null}
          onClose={() => {
            setSyncLeaderProfile(null);
          }}
          leaderProfile={syncLeaderProfile}
          allProfiles={profiles}
          runningProfiles={runningProfiles}
        />
      </div>
    </ProfileGroupDragProvider>
  );
}
