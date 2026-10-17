import type { AppPage } from "@/components/rail-nav";
import type { BrowserProfile, Entitlements } from "@/types";

/**
 * The plan capabilities a tip can be gated on. A tip that names one of these
 * is offered only when the signed-in plan grants it, so nobody is walked
 * through a feature they cannot open.
 */
export type TipRequirement = Extract<
  keyof Entitlements,
  | "cloudBackup"
  | "cookieBot"
  | "crossOsFingerprints"
  | "browserAutomation"
  | "teamCollaboration"
  | "remoteControl"
>;

/** Where a tip's action button takes the user. */
export type TipAction =
  | { kind: "page"; page: AppPage }
  | { kind: "settings"; section: string }
  | { kind: "palette" }
  | { kind: "feedback" }
  /** Puts an example query in the profile search box. */
  | { kind: "search"; query: string }
  | { kind: "createProfile" }
  | { kind: "totp" };

/** The catalog groups tips by these; `plan` holds every tip a plan unlocks. */
export type TipSection =
  | "everyday"
  | "network"
  | "privacy"
  | "connect"
  | "plan";

export const TIP_SECTIONS: readonly TipSection[] = [
  "everyday",
  "network",
  "privacy",
  "connect",
  "plan",
];

export type TipId =
  | "commandPalette"
  | "searchSyntax"
  | "shortcuts"
  | "groups"
  | "statuses"
  | "templates"
  | "extensionGroups"
  | "importProfiles"
  | "proxyCheck"
  | "vpn"
  | "dnsBlocklist"
  | "fingerprintGate"
  | "requireRoute"
  | "profilePassword"
  | "clearOnClose"
  | "totp"
  | "trash"
  | "selfHostedSync"
  | "defaultBrowser"
  | "localApi"
  | "feedback"
  | "cloudBackup"
  | "cookieBot"
  | "crossOs"
  | "synchronizer"
  | "automation"
  | "agent"
  | "team"
  | "remoteControl";

/**
 * Features that leave no trace in the data, so the app notes them as they
 * are used (`note_tip_feature_used`) and the tips for them stop coming.
 */
export type NotedFeature = Extract<
  TipId,
  | "commandPalette"
  | "searchSyntax"
  | "shortcuts"
  | "importProfiles"
  | "totp"
  | "synchronizer"
>;

/** The profile fields the relevance checks read. */
export type TipProfile = Pick<
  BrowserProfile,
  | "dns_blocklist"
  | "password_protected"
  | "clear_on_close"
  | "group_id"
  | "extension_group_id"
  | "sync_mode"
  | "host_os"
  | "vpn_id"
  | "status_id"
> & { wayfern_config?: { os?: string } };

/**
 * What this install already does, as far as the tips care. The first group
 * is data the app has loaded anyway; the optional facts are read from the
 * backend only when a tip that needs them is a candidate, and a fact that is
 * missing (not read, or the read failed) counts as "not in use".
 */
export interface FeatureUsage {
  profiles: readonly TipProfile[];
  /** The OS of this desktop, to tell a cross-OS fingerprint from a native one. */
  currentOs: string;
  groupCount: number;
  extensionGroupCount: number;
  vpnCount: number;
  inTeam: boolean;
  cookieBotEnrolled: boolean;
  syncServerConfigured: boolean;
  /** Features the app has seen in use (see `NotedFeature`). */
  noted: readonly string[];
  apiEnabled?: boolean;
  remoteControlEnabled?: boolean;
  /** The user turned the pre-launch fingerprint gate off, so they know it. */
  fingerprintGateChanged?: boolean;
  routeRequired?: boolean;
  proxyChecked?: boolean;
  isDefaultBrowser?: boolean;
  trashUsed?: boolean;
  templatesSaved?: boolean;
  /** An agent has connected over remote control during this app session. */
  agentUsed?: boolean;
  /** The person has sent feedback from the app. */
  feedbackSent?: boolean;
}

export interface TipDefinition {
  id: TipId;
  section: TipSection;
  action: TipAction;
  requires?: TipRequirement;
  /**
   * The feature changes team data, which a launcher seat may not do, so the
   * tip is not offered there.
   */
  editsTeamData?: true;
  /**
   * True when the user already uses the feature, so the inline tip skips it.
   * Every tip has one; a fact the app cannot read counts as "not in use".
   */
  inUse: (usage: FeatureUsage) => boolean;
}

function anyProfile(
  usage: FeatureUsage,
  test: (profile: TipProfile) => boolean,
): boolean {
  return usage.profiles.some(test);
}

function syncsProfiles(usage: FeatureUsage): boolean {
  return anyProfile(
    usage,
    (profile) => profile.sync_mode != null && profile.sync_mode !== "Disabled",
  );
}

function noted(feature: NotedFeature) {
  return (usage: FeatureUsage) => usage.noted.includes(feature);
}

/**
 * Every tip, in the order the catalog lists them: grouped by section, and
 * the plan tips last, each one skipped for a plan that lacks the capability.
 * The inline tip does not follow this order: it picks at random (see
 * `pickInlineTip`).
 *
 * The copy lives under `tips.items.<id>` in every locale: `label`, `title`,
 * `body` and `action`. `src/lib/tips.test.mjs` checks that no tip is missing its text.
 */
export const TIPS: readonly TipDefinition[] = [
  {
    id: "commandPalette",
    section: "everyday",
    action: { kind: "palette" },
    inUse: noted("commandPalette"),
  },
  {
    id: "searchSyntax",
    section: "everyday",
    action: { kind: "search", query: "proxy:none" },
    inUse: noted("searchSyntax"),
  },
  {
    id: "shortcuts",
    section: "everyday",
    action: { kind: "page", page: "shortcuts" },
    inUse: noted("shortcuts"),
  },
  {
    id: "groups",
    section: "everyday",
    editsTeamData: true,
    action: { kind: "page", page: "groups" },
    inUse: (usage) =>
      usage.groupCount > 0 ||
      anyProfile(usage, (profile) => !!profile.group_id),
  },
  {
    id: "statuses",
    section: "everyday",
    editsTeamData: true,
    action: { kind: "page", page: "profiles" },
    inUse: (usage) => anyProfile(usage, (profile) => !!profile.status_id),
  },
  {
    id: "templates",
    section: "everyday",
    editsTeamData: true,
    action: { kind: "createProfile" },
    inUse: (usage) => usage.templatesSaved === true,
  },
  {
    id: "extensionGroups",
    section: "everyday",
    editsTeamData: true,
    action: { kind: "page", page: "extensions" },
    inUse: (usage) =>
      usage.extensionGroupCount > 0 ||
      anyProfile(usage, (profile) => !!profile.extension_group_id),
  },
  {
    id: "importProfiles",
    section: "everyday",
    editsTeamData: true,
    action: { kind: "page", page: "import" },
    inUse: noted("importProfiles"),
  },
  {
    id: "proxyCheck",
    section: "network",
    action: { kind: "page", page: "proxies" },
    inUse: (usage) => usage.proxyChecked === true,
  },
  {
    id: "vpn",
    section: "network",
    editsTeamData: true,
    action: { kind: "page", page: "vpns" },
    inUse: (usage) =>
      usage.vpnCount > 0 || anyProfile(usage, (profile) => !!profile.vpn_id),
  },
  {
    id: "dnsBlocklist",
    section: "network",
    editsTeamData: true,
    action: { kind: "settings", section: "dns" },
    inUse: (usage) => anyProfile(usage, (profile) => !!profile.dns_blocklist),
  },
  {
    id: "fingerprintGate",
    section: "network",
    action: { kind: "settings", section: "advanced" },
    inUse: (usage) => usage.fingerprintGateChanged === true,
  },
  {
    id: "requireRoute",
    section: "network",
    action: { kind: "settings", section: "privacy" },
    inUse: (usage) => usage.routeRequired === true,
  },
  {
    id: "profilePassword",
    section: "privacy",
    editsTeamData: true,
    action: { kind: "page", page: "profiles" },
    inUse: (usage) =>
      anyProfile(usage, (profile) => profile.password_protected === true),
  },
  {
    id: "clearOnClose",
    section: "privacy",
    editsTeamData: true,
    action: { kind: "page", page: "profiles" },
    inUse: (usage) =>
      anyProfile(usage, (profile) => profile.clear_on_close === true),
  },
  {
    id: "totp",
    section: "privacy",
    editsTeamData: true,
    action: { kind: "totp" },
    inUse: noted("totp"),
  },
  {
    id: "trash",
    section: "privacy",
    editsTeamData: true,
    action: { kind: "page", page: "trash" },
    inUse: (usage) => usage.trashUsed === true,
  },
  {
    id: "selfHostedSync",
    section: "privacy",
    action: { kind: "page", page: "account" },
    inUse: (usage) => usage.syncServerConfigured || syncsProfiles(usage),
  },
  {
    id: "defaultBrowser",
    section: "connect",
    action: { kind: "settings", section: "default" },
    inUse: (usage) => usage.isDefaultBrowser === true,
  },
  {
    id: "localApi",
    section: "connect",
    action: { kind: "page", page: "integrations" },
    inUse: (usage) => usage.apiEnabled === true,
  },
  {
    id: "feedback",
    section: "connect",
    action: { kind: "feedback" },
    inUse: (usage) => usage.feedbackSent === true,
  },
  {
    id: "cloudBackup",
    section: "plan",
    action: { kind: "page", page: "account" },
    requires: "cloudBackup",
    inUse: syncsProfiles,
  },
  {
    id: "cookieBot",
    section: "plan",
    action: { kind: "page", page: "cookieBot" },
    requires: "cookieBot",
    inUse: (usage) => usage.cookieBotEnrolled,
  },
  {
    id: "crossOs",
    section: "plan",
    editsTeamData: true,
    action: { kind: "page", page: "profiles" },
    requires: "crossOsFingerprints",
    inUse: (usage) =>
      anyProfile(usage, (profile) => {
        const reported = profile.wayfern_config?.os;
        const native = profile.host_os ?? usage.currentOs;
        return !!reported && reported !== native;
      }),
  },
  {
    id: "synchronizer",
    section: "plan",
    action: { kind: "page", page: "profiles" },
    requires: "crossOsFingerprints",
    inUse: noted("synchronizer"),
  },
  {
    id: "automation",
    section: "plan",
    action: { kind: "page", page: "integrations" },
    requires: "browserAutomation",
    inUse: (usage) => usage.apiEnabled === true,
  },
  {
    id: "agent",
    section: "plan",
    action: { kind: "page", page: "agent" },
    requires: "remoteControl",
    inUse: (usage) => usage.agentUsed === true,
  },
  {
    id: "team",
    section: "plan",
    action: { kind: "page", page: "account" },
    requires: "teamCollaboration",
    inUse: (usage) => usage.inTeam,
  },
  {
    id: "remoteControl",
    section: "plan",
    action: { kind: "page", page: "integrations" },
    requires: "remoteControl",
    inUse: (usage) => usage.remoteControlEnabled === true,
  },
];

/** How long the profiles page has to sit quiet before the inline tip enters. */
export const INLINE_TIP_DELAY_MS = 4000;

/**
 * A sign-in younger than this counts as "just came back from the website",
 * which is when a paid account seen for the first time gets its welcome.
 */
export const FRESH_LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function isPlanTip(tip: TipDefinition): boolean {
  return tip.requires !== undefined;
}

/**
 * The tips this seat may see: every essential, plus the plan tips its plan
 * unlocks, without the ones that change team data on a launcher seat.
 */
export function tipsFor(
  entitlements: Pick<Entitlements, "active" | TipRequirement>,
  launcher = false,
): TipDefinition[] {
  return TIPS.filter(
    (tip) =>
      (tip.requires === undefined ||
        (entitlements.active && entitlements[tip.requires])) &&
      !(launcher && tip.editsTeamData),
  );
}

export function isKnownTip(id: string): id is TipId {
  return TIPS.some((tip) => tip.id === id);
}

/**
 * What becomes of the tip pinned on the page. An id the app no longer has is
 * closed; a known tip this seat is not offered (its plan is gone) is
 * released unread, back to the pool; an offered one is checked for use.
 * Call it only once the account has loaded, so a plan still loading never
 * releases its tip.
 */
export function pinnedTipFate(
  pinned: string,
  offered: readonly TipDefinition[],
): "close" | "release" | "check" {
  if (!isKnownTip(pinned)) return "close";
  return offered.some((tip) => tip.id === pinned) ? "check" : "release";
}

/** The tips the inline flow may still show: unseen, and not in use. */
export function inlineTipCandidates(
  tips: readonly TipDefinition[],
  seen: readonly string[],
  usage: FeatureUsage,
): TipDefinition[] {
  return tips.filter((tip) => !seen.includes(tip.id) && !tip.inUse(usage));
}

/**
 * The one tip the inline flow shows: a random unseen tip for a feature the
 * user does not use yet, or null when none is left. `random` returns a
 * number in [0, 1), like `Math.random`.
 */
export function pickInlineTip(
  tips: readonly TipDefinition[],
  seen: readonly string[],
  usage: FeatureUsage,
  random: () => number = Math.random,
): TipDefinition | null {
  const candidates = inlineTipCandidates(tips, seen, usage);
  if (candidates.length === 0) return null;
  const index = Math.min(
    candidates.length - 1,
    Math.floor(random() * candidates.length),
  );
  return candidates[index];
}

/**
 * Whether the action would only lead to `page`, where the person already is.
 * The inline tip on that page then shows no action button: the copy says
 * where the feature is.
 */
export function actionStaysOn(action: TipAction, page: AppPage): boolean {
  return action.kind === "page" && action.page === page;
}

export function tipTextKeys(id: TipId): {
  /** The short name the catalog lists the tip under. */
  label: string;
  title: string;
  body: string;
  action: string;
} {
  return {
    label: `tips.items.${id}.label`,
    title: `tips.items.${id}.title`,
    body: `tips.items.${id}.body`,
    action: `tips.items.${id}.action`,
  };
}
