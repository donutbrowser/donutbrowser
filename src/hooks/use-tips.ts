import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppPage } from "@/components/rail-nav";
import { getAgentConsole } from "@/lib/agent-console";
import { COACH_MARK_EXIT_MS } from "@/lib/coach-mark";
import {
  effectivePlanOf,
  getEntitlements,
  isTeamLauncher,
} from "@/lib/entitlements";
import { getCurrentOS } from "@/lib/platform";
import { parseProfileSearch } from "@/lib/profile-search";
import {
  type FeatureUsage,
  FRESH_LOGIN_WINDOW_MS,
  INLINE_TIP_DELAY_MS,
  isPlanTip,
  type NotedFeature,
  pickInlineTip,
  pinnedTipFate,
  type TipAction,
  type TipDefinition,
  type TipId,
  type TipProfile,
  tipsFor,
} from "@/lib/tips";
import type { CloudUser } from "@/types";

/** Mirror of `settings_manager::TipsState`. */
export interface TipsState {
  auto_show: boolean;
  seen: string[];
  used: string[];
  inline_tip: string | null;
  last_auto_shown_at: number | null;
  next_auto_show_at: number | null;
  auto_due: boolean;
}

/** What the app has already loaded that tells which features are in use. */
export interface TipUsageSource {
  /** False while any of the lists below is still loading. */
  loaded: boolean;
  profiles: readonly TipProfile[];
  groupCount: number;
  extensionGroupCount: number;
  vpnCount: number;
  cookieBotEnrolled: boolean;
  syncServerConfigured: boolean;
  proxyIds: readonly string[];
}

/**
 * What the person is doing right now. Some features leave no trace in the
 * data, so the tips note them here, once, as they are used.
 */
export interface TipActivity {
  page: AppPage;
  paletteOpen: boolean;
  searchQuery: string;
  totpOpen: boolean;
  synchronizing: boolean;
}

/** The settings fields the relevance checks read. */
interface UsageSettings {
  api_enabled?: boolean;
  mcp_remote_enabled?: boolean;
  fingerprint_gate_disabled?: boolean;
  require_route_for_launch?: boolean;
  feedback_sent_at?: number | null;
}

/** A slow read must not hold the tip back for long. */
const USAGE_READ_TIMEOUT_MS = 5000;
const PROXY_HISTORY_BATCH = 16;
/** How often a long session looks again for the next day's tip. */
const INLINE_TIP_RECHECK_MS = 15 * 60 * 1000;
/** Backend facts behind the tip on the page are read again at most this often. */
const FACTS_REFRESH_MS = 60 * 1000;

/**
 * The answer of one usage read, or undefined when it fails or is too slow.
 * An unknown fact counts as "not in use", so it never hides a tip.
 */
function known<T>(read: Promise<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(
      () => resolve(undefined),
      USAGE_READ_TIMEOUT_MS,
    );
    read
      .then(resolve, (error: unknown) => {
        console.warn("Failed to read a tip usage fact:", error);
        resolve(undefined);
      })
      .finally(() => window.clearTimeout(timer));
  });
}

/** Whether any proxy has a check on record, stopping at the first one. */
async function anyProxyChecked(proxyIds: readonly string[]): Promise<boolean> {
  for (let start = 0; start < proxyIds.length; start += PROXY_HISTORY_BATCH) {
    const histories = await Promise.all(
      proxyIds
        .slice(start, start + PROXY_HISTORY_BATCH)
        .map((proxyId) =>
          invoke<unknown[]>("get_proxy_check_history", { proxyId }),
        ),
    );
    if (histories.some((history) => history.length > 0)) return true;
  }
  return false;
}

/** The part of the usage facts the app holds in memory, read every render. */
function liveUsage(
  source: TipUsageSource,
  inTeam: boolean,
  noted: readonly string[],
): FeatureUsage {
  return {
    profiles: source.profiles,
    currentOs: getCurrentOS(),
    groupCount: source.groupCount,
    extensionGroupCount: source.extensionGroupCount,
    vpnCount: source.vpnCount,
    inTeam,
    cookieBotEnrolled: source.cookieBotEnrolled,
    syncServerConfigured: source.syncServerConfigured,
    noted,
  };
}

/**
 * The usage facts for the tips in `candidates`. The backend is asked only
 * for what a candidate's relevance check reads, so a user who has seen the
 * proxy tip never pays for a read of every proxy's check history.
 */
async function loadFeatureUsage(
  live: FeatureUsage,
  proxyIds: readonly string[],
  candidates: ReadonlySet<TipId>,
): Promise<FeatureUsage> {
  const wants = (...ids: TipId[]) => ids.some((id) => candidates.has(id));
  const [
    settings,
    proxyChecked,
    isDefaultBrowser,
    trashUsed,
    templatesSaved,
    agentUsed,
  ] = await Promise.all([
    wants(
      "localApi",
      "automation",
      "remoteControl",
      "fingerprintGate",
      "requireRoute",
      "feedback",
    )
      ? known(invoke<UsageSettings>("get_app_settings"))
      : undefined,
    wants("proxyCheck") ? known(anyProxyChecked(proxyIds)) : undefined,
    wants("defaultBrowser")
      ? known(invoke<boolean>("is_default_browser"))
      : undefined,
    wants("trash")
      ? known(
          invoke<unknown[]>("list_trashed_profiles").then(
            (trashed) => trashed.length > 0,
          ),
        )
      : undefined,
    wants("templates")
      ? known(
          invoke<unknown[]>("list_profile_templates").then(
            (templates) => templates.length > 0,
          ),
        )
      : undefined,
    wants("agent")
      ? known(
          getAgentConsole().then((snapshot) => snapshot.sessions.length > 0),
        )
      : undefined,
  ]);
  return {
    ...live,
    apiEnabled: settings?.api_enabled,
    remoteControlEnabled: settings?.mcp_remote_enabled,
    fingerprintGateChanged: settings?.fingerprint_gate_disabled,
    routeRequired: settings?.require_route_for_launch,
    proxyChecked,
    isDefaultBrowser,
    trashUsed,
    templatesSaved,
    agentUsed,
    feedbackSent:
      settings === undefined ? undefined : settings.feedback_sent_at != null,
  };
}

/** A query that uses at least one field, such as `tag:work`. */
function searchUsesFields(query: string): boolean {
  if (!query.includes(":")) return false;
  return parseProfileSearch(query).groups.some((group) =>
    group.some((term) => term.type === "field"),
  );
}

/** Something modal is open, so the inline tip waits. */
function modalOpen(): boolean {
  return Boolean(
    document.querySelector('[role="dialog"], [role="alertdialog"]'),
  );
}

export interface TipsDialogState {
  open: boolean;
  initialTipId: TipId | null;
  /** Bumped on every open so the dialog remounts with fresh navigation state. */
  session: number;
}

interface PaidWelcomeState {
  plan: string;
  status: "pending" | "open" | "done";
}

interface InlineState {
  id: TipId;
  leaving: boolean;
}

/** The tip a coach mark points out on the Profiles page right now. */
export interface PageTip {
  tip: TipDefinition;
  leaving: boolean;
  /**
   * Asked for from the catalog ("Show me"). It is read already, so closing it
   * records nothing and does not count as the day's tip.
   */
  preview: boolean;
}

interface UseTipsOptions {
  cloudUser: CloudUser | null;
  /** The account is still loading, so the plan's tips are not known yet. */
  accountLoading: boolean;
  loggedInAt: string | null;
  /**
   * The app is settled enough to show something unasked: not the first-run
   * session, terms accepted, nothing else blocking.
   */
  ready: boolean;
  /** Read when the inline tip is chosen, to skip features already in use. */
  usage: TipUsageSource;
  activity: TipActivity;
}

/**
 * The tips flow: which tips this install may see, what has been seen, the
 * one tip a day that a coach mark points out on the Profiles page, and the
 * welcome for an account that just turned paid. State lives in the app
 * settings; this hook only decides.
 */
export function useTips({
  cloudUser,
  accountLoading,
  loggedInAt,
  ready,
  usage,
  activity,
}: UseTipsOptions) {
  const [state, setState] = useState<TipsState | null>(null);
  const [dialog, setDialog] = useState<TipsDialogState>({
    open: false,
    initialTipId: null,
    session: 0,
  });
  const [paidWelcome, setPaidWelcome] = useState<PaidWelcomeState | null>(null);
  const [inline, setInline] = useState<InlineState | null>(null);
  const [preview, setPreview] = useState<InlineState | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const entitlements = useMemo(() => getEntitlements(cloudUser), [cloudUser]);
  const launcher = isTeamLauncher(cloudUser);
  const tips = useMemo(
    () => tipsFor(entitlements, launcher),
    [entitlements, launcher],
  );
  const planTips = useMemo(() => tips.filter(isPlanTip), [tips]);
  const inTeam = Boolean(cloudUser?.teamId);

  useEffect(() => {
    let cancelled = false;
    invoke<TipsState>("get_tips_state")
      .then((loaded) => {
        if (!cancelled) setState(loaded);
      })
      .catch((error: unknown) => {
        console.error("Failed to load the tips state:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(
      () => setClock(Date.now()),
      INLINE_TIP_RECHECK_MS,
    );
    return () => window.clearInterval(timer);
  }, []);

  const openTips = useCallback((initialTipId: TipId | null = null) => {
    setDialog((previous) => ({
      open: true,
      initialTipId,
      session: previous.session + 1,
    }));
  }, []);

  const closeTips = useCallback(() => {
    setDialog((previous) =>
      previous.open ? { ...previous, open: false } : previous,
    );
  }, []);

  // One observation per account and plan status. The backend remembers the
  // status and answers whether this is the moment to greet a new paid plan.
  const observedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!cloudUser) return;
    const paid = entitlements.active;
    const key = `${cloudUser.id}:${paid ? "paid" : "free"}`;
    if (observedRef.current === key) return;
    observedRef.current = key;
    const freshLogin =
      loggedInAt !== null &&
      Date.now() - Date.parse(loggedInAt) < FRESH_LOGIN_WINDOW_MS;
    invoke<boolean>("observe_cloud_plan", {
      userId: cloudUser.id,
      paid,
      freshLogin,
    })
      .then((due) => {
        if (!due) return;
        setPaidWelcome({ plan: effectivePlanOf(cloudUser), status: "pending" });
      })
      .catch((error: unknown) => {
        console.error("Failed to record the cloud plan:", error);
      });
  }, [cloudUser, entitlements.active, loggedInAt]);

  // The welcome waits for a quiet moment: the app settled and no tips open.
  useEffect(() => {
    if (!ready || dialog.open || paidWelcome?.status !== "pending") return;
    setPaidWelcome({ plan: paidWelcome.plan, status: "open" });
  }, [ready, dialog.open, paidWelcome]);

  // Features with no trace in the data are noted once, as they are used.
  const notingRef = useRef(new Set<string>());
  const used = state?.used;
  const noteFeature = useCallback(
    (feature: NotedFeature) => {
      if (!used || used.includes(feature)) return;
      if (notingRef.current.has(feature)) return;
      notingRef.current.add(feature);
      invoke<TipsState>("note_tip_feature_used", { tipId: feature })
        .then(setState)
        .catch((error: unknown) => {
          console.warn("Failed to note a feature in use:", error);
        })
        .finally(() => notingRef.current.delete(feature));
    },
    [used],
  );
  const fieldSearch = useMemo(
    () => searchUsesFields(activity.searchQuery),
    [activity.searchQuery],
  );
  useEffect(() => {
    if (activity.paletteOpen) noteFeature("commandPalette");
    if (fieldSearch) noteFeature("searchSyntax");
    if (activity.page === "shortcuts") noteFeature("shortcuts");
    if (activity.page === "import") noteFeature("importProfiles");
    if (activity.totpOpen) noteFeature("totp");
    if (activity.synchronizing) noteFeature("synchronizer");
  }, [
    activity.paletteOpen,
    fieldSearch,
    activity.page,
    activity.totpOpen,
    activity.synchronizing,
    noteFeature,
  ]);

  // The usage lists change all the time (a profile starts, a group count
  // moves); they are read when the tip is chosen, not watched, so a change
  // does not restart the delay below.
  const usageRef = useRef(usage);
  const stateRef = useRef(state);
  const inlineRef = useRef(inline);
  useEffect(() => {
    usageRef.current = usage;
    stateRef.current = state;
    inlineRef.current = inline;
  });

  const [facts, setFacts] = useState<FeatureUsage | null>(null);
  const factsReadAtRef = useRef(0);
  /** Tips closed in this session; a stale state never brings one back. */
  const resolvedRef = useRef(new Set<string>());
  const attemptedAtRef = useRef<number | null>(null);

  const resolveInline = useCallback(async (id: string) => {
    resolvedRef.current.add(id);
    try {
      setState(await invoke<TipsState>("mark_tip_seen", { tipId: id }));
    } catch (error) {
      console.error("Failed to close the inline tip:", error);
    }
  }, []);

  const leaveInline = useCallback(() => {
    setInline((previous) =>
      previous && !previous.leaving ? { ...previous, leaving: true } : previous,
    );
  }, []);

  useEffect(() => {
    if (!inline?.leaving) return;
    // Removed after the coach mark's exit, even if no frame ran.
    const timer = window.setTimeout(() => setInline(null), COACH_MARK_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [inline?.leaving]);

  const pinned = (state?.inline_tip ?? null) as TipId | null;
  const due =
    !!state &&
    state.auto_show &&
    !pinned &&
    (state.next_auto_show_at === null ||
      clock / 1000 >= state.next_auto_show_at);
  const onProfiles = activity.page === "profiles" && usage.profiles.length > 0;
  const welcomeBusy = paidWelcome !== null && paidWelcome.status !== "done";

  // The inline tip: the pinned one comes back after a restart, and a new one
  // is picked at most once a day. Both wait until the Profiles page has sat
  // quiet for a moment with nothing modal on it.
  useEffect(() => {
    if (!ready || accountLoading || !usage.loaded) return;
    if (!state?.auto_show || inline) return;
    if (!onProfiles || dialog.open || welcomeBusy || preview) return;
    if (!pinned && !due) return;
    if (!pinned && attemptedAtRef.current === clock) return;
    let cancelled = false;
    let timer = 0;
    const attempt = () => {
      if (modalOpen()) {
        timer = window.setTimeout(attempt, INLINE_TIP_DELAY_MS);
        return;
      }
      void (async () => {
        const current = stateRef.current;
        if (!current) return;
        const live = liveUsage(usageRef.current, inTeam, current.used);
        const proxyIds = usageRef.current.proxyIds;
        if (pinned) {
          const fate = pinnedTipFate(pinned, tips);
          if (fate === "close") {
            await resolveInline(pinned);
            return;
          }
          if (fate === "release") {
            // Unread, back to the pool; the day rule then picks another.
            const next = await invoke<TipsState>("release_inline_tip", {
              tipId: pinned,
            }).catch((error: unknown) => {
              console.error("Failed to release the inline tip:", error);
              return null;
            });
            if (next) setState(next);
            return;
          }
          const tip = tips.find((item) => item.id === pinned);
          if (!tip) return;
          const loaded = await loadFeatureUsage(
            live,
            proxyIds,
            new Set([tip.id]),
          );
          if (cancelled) return;
          if (
            resolvedRef.current.has(tip.id) ||
            current.seen.includes(tip.id) ||
            tip.inUse(loaded)
          ) {
            await resolveInline(tip.id);
            return;
          }
          factsReadAtRef.current = Date.now();
          setFacts(loaded);
          setInline({ id: tip.id, leaving: false });
          return;
        }
        const unseen = tips.filter((tip) => !current.seen.includes(tip.id));
        const loaded = await loadFeatureUsage(
          live,
          proxyIds,
          new Set(unseen.map((tip) => tip.id)),
        );
        if (cancelled) return;
        attemptedAtRef.current = clock;
        const tip = pickInlineTip(tips, current.seen, loaded);
        if (!tip) return;
        const next = await invoke<TipsState>("show_inline_tip", {
          tipId: tip.id,
        }).catch((error: unknown) => {
          console.error("Failed to show the inline tip:", error);
          return null;
        });
        if (!next || cancelled) return;
        setState(next);
        if (next.inline_tip !== tip.id) return;
        factsReadAtRef.current = Date.now();
        setFacts(loaded);
        setInline({ id: tip.id, leaving: false });
      })();
    };
    timer = window.setTimeout(attempt, INLINE_TIP_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    ready,
    accountLoading,
    usage.loaded,
    state?.auto_show,
    inline,
    onProfiles,
    dialog.open,
    welcomeBusy,
    preview,
    pinned,
    due,
    clock,
    tips,
    inTeam,
    resolveInline,
  ]);

  const inlineTip = inline
    ? (tips.find((tip) => tip.id === inline.id) ?? null)
    : null;

  // The coach mark leaves on its own once its tip is done with: read in the
  // catalog, tips switched off, or the feature put to use.
  useEffect(() => {
    if (!inline || inline.leaving || !state) return;
    if (!inlineTip || !state.auto_show || state.inline_tip !== inline.id) {
      leaveInline();
      return;
    }
    if (!facts) return;
    const now = {
      ...facts,
      ...liveUsage(usage, inTeam, state.used),
    };
    if (inlineTip.inUse(now)) {
      leaveInline();
      void resolveInline(inline.id);
    }
  }, [
    inline,
    inlineTip,
    state,
    facts,
    usage,
    inTeam,
    leaveInline,
    resolveInline,
  ]);

  // Facts read from the backend (a proxy check, the API switch, the trash)
  // can change while the coach mark is up. They are read again when the person
  // comes back to the Profiles page or to the window, at most once a minute.
  const [returnedAt, setReturnedAt] = useState(0);
  useEffect(() => {
    const onFocus = () => setReturnedAt(Date.now());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => {
    if (activity.page === "profiles") setReturnedAt(Date.now());
  }, [activity.page]);
  const shownId = inline && !inline.leaving ? inline.id : null;
  useEffect(() => {
    const current = stateRef.current;
    if (!shownId || !current) return;
    if (returnedAt - factsReadAtRef.current < FACTS_REFRESH_MS) return;
    factsReadAtRef.current = returnedAt;
    let cancelled = false;
    void loadFeatureUsage(
      liveUsage(usageRef.current, inTeam, current.used),
      usageRef.current.proxyIds,
      new Set([shownId]),
    ).then((loaded) => {
      if (!cancelled && inlineRef.current?.id === shownId) setFacts(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [shownId, returnedAt, inTeam]);

  const dismissInlineTip = useCallback(() => {
    const current = inlineRef.current;
    if (!current || current.leaving) return;
    leaveInline();
    void resolveInline(current.id);
  }, [leaveInline, resolveInline]);

  // "Show me" from the catalog: the catalog closes and a coach mark points at
  // the feature. The day's tip, if one is up, waits behind it.
  const showOnPage = useCallback((id: TipId) => {
    setDialog((previous) =>
      previous.open ? { ...previous, open: false } : previous,
    );
    setPreview({ id, leaving: false });
  }, []);

  useEffect(() => {
    if (!preview?.leaving) return;
    const timer = window.setTimeout(() => setPreview(null), COACH_MARK_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [preview?.leaving]);

  const previewTip = preview
    ? (tips.find((tip) => tip.id === preview.id) ?? null)
    : null;
  const pageTip: PageTip | null = previewTip
    ? { tip: previewTip, leaving: preview?.leaving ?? false, preview: true }
    : inlineTip
      ? { tip: inlineTip, leaving: inline?.leaving ?? false, preview: false }
      : null;

  const dismissPageTip = useCallback(() => {
    if (preview) {
      setPreview((previous) =>
        previous && !previous.leaving
          ? { ...previous, leaving: true }
          : previous,
      );
      return;
    }
    dismissInlineTip();
  }, [preview, dismissInlineTip]);

  const markSeen = useCallback(async (id: TipId) => {
    try {
      setState(await invoke<TipsState>("mark_tip_seen", { tipId: id }));
    } catch (error) {
      console.error("Failed to remember the tip as seen:", error);
    }
  }, []);

  const setAutoShow = useCallback(async (enabled: boolean) => {
    try {
      setState(await invoke<TipsState>("set_tips_auto_show", { enabled }));
      return true;
    } catch (error) {
      console.error("Failed to save the tips preference:", error);
      return false;
    }
  }, []);

  const dismissPaidWelcome = useCallback(() => {
    setPaidWelcome((previous) =>
      previous ? { ...previous, status: "done" } : previous,
    );
  }, []);

  return {
    tips,
    planTips,
    seen: state?.seen ?? [],
    autoShow: state?.auto_show ?? true,
    dialog,
    openTips,
    closeTips,
    markSeen,
    setAutoShow,
    pageTip,
    dismissPageTip,
    showOnPage,
    paidWelcome: {
      open: paidWelcome?.status === "open",
      plan: paidWelcome?.plan ?? "",
    },
    dismissPaidWelcome,
  };
}

export type TipsFlow = ReturnType<typeof useTips>;
export type { TipAction, TipDefinition };
