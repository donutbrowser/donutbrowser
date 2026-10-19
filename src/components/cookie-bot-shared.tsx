"use client";

import { invoke } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";
import { animate, motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { IconType } from "react-icons";
import {
  LuCircleCheck,
  LuCircleDashed,
  LuCircleSlash,
  LuCircleStop,
  LuCircleX,
  LuClock,
  LuLoaderCircle,
} from "react-icons/lu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { parseBackendError, translateBackendError } from "@/lib/backend-errors";
import {
  type CookieBotRun,
  type CookieBotSchedule,
  isCookieBotPlatform,
  type RemoteHoursQuota,
} from "@/lib/cookie-bot";
import { MOTION_EASE_OUT } from "@/lib/motion";
import type { RemoteSessionState } from "@/lib/remote-sessions";
import { cn } from "@/lib/utils";
import type { BrowserProfile, WayfernFingerprintConfig } from "@/types";

/* -------------------------------------------------------------------------- */
/* Cadence                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Weekday bitmask, bit 0 = Monday. The masks below are the only three the
 * enrolment dialog offers; anything else that comes back from the server is
 * rendered as its own weekday list rather than forced into one of these.
 */
export const DAYS_NIGHTLY = 127;
export const DAYS_WEEKNIGHTS = 31;
export const DAYS_ALTERNATE = 85; // Mon / Wed / Fri / Sun

export type CadenceId = "nightly" | "weeknights" | "alternate";

export const CADENCES: { id: CadenceId; mask: number; labelKey: string }[] = [
  {
    id: "nightly",
    mask: DAYS_NIGHTLY,
    labelKey: "cookieBot.enrol.cadenceNightly",
  },
  {
    id: "weeknights",
    mask: DAYS_WEEKNIGHTS,
    labelKey: "cookieBot.enrol.cadenceWeeknights",
  },
  {
    id: "alternate",
    mask: DAYS_ALTERNATE,
    labelKey: "cookieBot.enrol.cadenceAlternate",
  },
];

export function cadenceForMask(mask: number): CadenceId | null {
  return CADENCES.find((c) => c.mask === mask)?.id ?? null;
}

export function nightsPerWeek(mask: number): number {
  let count = 0;
  for (let bit = 0; bit < 7; bit += 1) {
    if ((mask & (1 << bit)) !== 0) count += 1;
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/* Slots                                                                      */
/* -------------------------------------------------------------------------- */

export { scheduleSlots } from "@/lib/schedule-layout";

/**
 * How many times a week a whole calendar fires.
 *
 * Counted across slots, not read off the first one: an enrolment with three
 * slots costs three times the hours, and the budget estimate beside it is the
 * only place a user sees that before committing.
 *
 * DISTINCT (weekday, minute) pairs rather than a sum of night counts, because
 * two slots landing on the same weekday at the same minute are the same
 * instant and the server dispatches them as ONE run — `upcomingSlotsMulti`
 * collapses coincident fires. Summing quoted a Mon+Tue and a Tue+Wed slot at
 * 02:00 as four nights when it is three, and that inflated figure is what the
 * over-budget warning is compared against.
 */
export function weeklyRuns(
  slots: { days_mask: number; run_at_minute: number }[],
): number {
  const fires = new Set<number>();
  for (const slot of slots) {
    for (let bit = 0; bit < 7; bit += 1) {
      if ((slot.days_mask & (1 << bit)) !== 0) {
        fires.add(bit * 1440 + slot.run_at_minute);
      }
    }
  }
  return fires.size;
}

/**
 * Monday-first weekday names, from the viewer's own locale.
 *
 * Derived rather than translated into ten locale files: `narrow` already gives
 * each language its own single-letter convention, and a hand-written table
 * would be ten more places for Monday-first to be got wrong. The reference week
 * is formatted in UTC so a user east of Greenwich does not see it shift by a
 * day.
 */
export function weekdayNames(): { narrow: string; long: string }[] {
  // 2024-01-01 was a Monday, which is bit 0 of the server's mask.
  const monday = Date.UTC(2024, 0, 1);
  const narrow = new Intl.DateTimeFormat(undefined, {
    weekday: "narrow",
    timeZone: "UTC",
  });
  const long = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    timeZone: "UTC",
  });
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday + index * 24 * 60 * 60 * 1000);
    return { narrow: narrow.format(day), long: long.format(day) };
  });
}

/** A human cadence label. Unknown masks fall back to the day count. */
export function describeCadence(t: TFunction, mask: number): string {
  const id = cadenceForMask(mask);
  if (id) {
    return t(CADENCES.find((c) => c.id === id)?.labelKey ?? "");
  }
  return t("cookieBot.enrol.cadenceCustom", { count: nightsPerWeek(mask) });
}

/* -------------------------------------------------------------------------- */
/* Time formatting                                                            */
/* -------------------------------------------------------------------------- */

/** `137` -> `02:17`. Always zero-padded so the column stays on one grid. */
export function minutesToClock(minutes: number): string {
  const safe = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** `02:17` -> `137`. Returns null for anything that isn't a real time. */
export function clockToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/** `724` -> `12:04`. Used for the live elapsed clock; never rounds up. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** `724` -> `12m 04s`, for a finished run's duration column. */
export function formatDuration(t: TFunction, seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return t("cookieBot.duration.hm", { hours: h, minutes: m });
  if (m > 0) {
    return t("cookieBot.duration.ms", {
      minutes: m,
      seconds: String(s).padStart(2, "0"),
    });
  }
  return t("cookieBot.duration.s", { seconds: s });
}

/** Parses a server ISO timestamp. Returns null rather than an Invalid Date. */
export function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(
  value: string | null | undefined,
): string | null {
  const date = parseIso(value);
  if (!date) return null;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatDate(value: string | null | undefined): string | null {
  const date = parseIso(value);
  if (!date) return null;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

/** `Oct 6, 02:14`: a short moment for a narrow column. */
export function formatShortDateTime(
  value: string | null | undefined,
): string | null {
  const date = parseIso(value);
  if (!date) return null;
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The wall-clock time in the enrolment's own zone. A zone name the server
 * sends but this WebView does not know would throw from `Intl`; the local
 * clock is the honest fallback, never a crash.
 */
export function clockInZone(at: Date, timeZone: string | null): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
  };
  try {
    return at.toLocaleTimeString(undefined, {
      ...options,
      timeZone: timeZone || undefined,
    });
  } catch {
    return at.toLocaleTimeString(undefined, options);
  }
}

/** Minutes past midnight right now in `timeZone`, or null for a zone `Intl` does not know. */
export function minuteOfDayInZone(
  now: number,
  timeZone: string,
): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: timeZone || undefined,
    }).formatToParts(new Date(now));
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return (hour % 24) * 60 + minute;
  } catch {
    return null;
  }
}

/**
 * The calendar day of `time` in `timeZone`, as a day count. Falls back to this
 * machine's zone when `Intl` does not know the zone.
 */
function dayNumberInZone(time: number, timeZone: string | null): number {
  const read = (zone: string | undefined) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      timeZone: zone,
    }).formatToParts(new Date(time));
    const part = (type: string) =>
      Number(parts.find((item) => item.type === type)?.value);
    return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000;
  };
  try {
    return read(timeZone || undefined);
  } catch {
    return read(undefined);
  }
}

/** A date option set in `timeZone`, or in this machine's zone when `Intl` does not know it. */
function zonedDateString(
  at: Date,
  options: Intl.DateTimeFormatOptions,
  timeZone: string | null,
): string {
  try {
    return at.toLocaleDateString(undefined, {
      ...options,
      timeZone: timeZone || undefined,
    });
  } catch {
    return at.toLocaleDateString(undefined, options);
  }
}

/**
 * When the next run is, as a person would say it: "In 25 min", "In 3 h",
 * "Today", "Tomorrow", then the weekday or the date. Days are counted in
 * `timeZone`, the zone the run's clock time is shown in.
 */
export function relativeRunLabel(
  t: TFunction,
  at: Date,
  now: number,
  timeZone: string | null,
): string {
  const diff = at.getTime() - now;
  if (diff <= 60_000) return t("cookieBot.next.now");
  if (diff < 60 * 60_000) {
    return t("cookieBot.next.inMinutes", { count: Math.ceil(diff / 60_000) });
  }
  if (diff < 12 * 60 * 60_000) {
    return t("cookieBot.next.inHours", {
      count: Math.max(1, Math.round(diff / (60 * 60_000))),
    });
  }
  const days =
    dayNumberInZone(at.getTime(), timeZone) - dayNumberInZone(now, timeZone);
  if (days <= 0) return t("cookieBot.next.today");
  if (days === 1) return t("cookieBot.next.tomorrow");
  if (days < 7) return zonedDateString(at, { weekday: "long" }, timeZone);
  return zonedDateString(at, { day: "numeric", month: "short" }, timeZone);
}

/** The current time, read again every `intervalMs` while `active`. */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(id);
    };
  }, [intervalMs, active]);
  return now;
}

/**
 * A number that counts to its new value when it changes. The first paint is
 * the true value; only later changes animate, and reduced motion jumps.
 */
export function TickingNumber({
  value,
  format,
  className,
}: {
  value: number;
  format: (value: number) => string;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  const formatRef = useRef(format);
  formatRef.current = format;
  const text = format(value);

  // The text is written here rather than rendered, so a frame of the count
  // never fights React over the same text node.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const from = shown.current;
    if (reduceMotion || from === value || !Number.isFinite(from)) {
      shown.current = value;
      node.textContent = text;
      return;
    }
    const controls = animate(from, value, {
      duration: 0.6,
      ease: MOTION_EASE_OUT,
      onUpdate: (latest) => {
        shown.current = latest;
        node.textContent = formatRef.current(latest);
      },
      onComplete: () => {
        shown.current = value;
        node.textContent = formatRef.current(value);
      },
    });
    return () => {
      controls.stop();
    };
  }, [value, reduceMotion, text]);

  return <span ref={ref} className={cn("tabular-nums", className)} />;
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                  */
/* -------------------------------------------------------------------------- */

export type PreflightCode =
  | "syncOff"
  | "encrypted"
  | "unknownPlatform"
  | "unsupportedPlatform"
  | "noExitNode";

/** The one-click repairs a failed preflight can name. */
export type PreflightFix = "sync" | "syncSettings" | "proxy";

export interface PreflightResult {
  eligible: boolean;
  code: PreflightCode | null;
  /** Substituted into the reason line, e.g. the refused OS name. */
  params: Record<string, string>;
  /** Which one-click repair applies, when one does. */
  fix: PreflightFix | null;
}

const ELIGIBLE: PreflightResult = {
  eligible: true,
  code: null,
  params: {},
  fix: null,
};

/** The OS a profile claims, from its own record then its fingerprint. */
export function resolvedOs(profile: BrowserProfile): string | null {
  return profile.host_os ?? profile.wayfern_config?.os ?? null;
}

/**
 * The exact refusals `cookie_bot::bot_precondition` applies, evaluated here so
 * a user finds out at enrolment rather than at the first run. Keeping the
 * two in step matters: a profile this says is fine but the backend refuses
 * would burn a schedule row and a run.
 */
export function preflight(profile: BrowserProfile): PreflightResult {
  const syncMode = profile.sync_mode ?? "Disabled";
  if (syncMode === "Disabled") {
    return { eligible: false, code: "syncOff", params: {}, fix: "sync" };
  }
  if (syncMode === "Encrypted") {
    return {
      eligible: false,
      code: "encrypted",
      params: {},
      fix: "syncSettings",
    };
  }
  const os = resolvedOs(profile);
  if (!os) {
    return {
      eligible: false,
      code: "unknownPlatform",
      params: {},
      fix: null,
    };
  }
  if (!isCookieBotPlatform(os)) {
    return {
      eligible: false,
      code: "unsupportedPlatform",
      params: { os },
      fix: null,
    };
  }
  if (!profile.proxy_id && !profile.vpn_id) {
    return { eligible: false, code: "noExitNode", params: {}, fix: "proxy" };
  }
  return ELIGIBLE;
}

/**
 * Whether this profile could be launched on a remote host.
 *
 * A strict subset of {@link preflight}: a remote session needs the profile to
 * exist in cloud storage in a form a host can read, and nothing more. The bot's
 * extra requirement — an exit node — exists because a night of unattended
 * traffic from a datacenter address is worse for the profile than not warming
 * it, and that reasoning does not apply to a session the user is driving.
 *
 * Mirrors `remote_launch_profile_rules` in `api_server.rs`, which is
 * authoritative; this only avoids offering an action that would be refused.
 */
export function canLaunchRemotely(profile: BrowserProfile): boolean {
  const syncMode = profile.sync_mode ?? "Disabled";
  if (syncMode === "Disabled" || syncMode === "Encrypted") return false;
  return resolvedOs(profile) !== null;
}

export function preflightReason(t: TFunction, result: PreflightResult): string {
  switch (result.code) {
    case "syncOff":
      return t("cookieBot.preflight.reasonSync");
    case "encrypted":
      return t("cookieBot.preflight.reasonEncrypted");
    case "unknownPlatform":
      return t("cookieBot.preflight.reasonNoFingerprint");
    case "unsupportedPlatform":
      return t("cookieBot.preflight.reasonCrossOs", {
        os: result.params.os ?? "",
      });
    case "noExitNode":
      return t("cookieBot.preflight.reasonNoExitNode");
    default:
      return "";
  }
}

export function preflightFixLabel(
  t: TFunction,
  fix: PreflightResult["fix"],
): string | null {
  switch (fix) {
    case "sync":
      return t("cookieBot.preflight.fixSync");
    case "syncSettings":
      return t("cookieBot.preflight.fixEncrypted");
    case "proxy":
      return t("cookieBot.preflight.fixProxy");
    default:
      return null;
  }
}

/** Turning sync on is the one repair the dialog can perform by itself. */
export function enableProfileSync(profileId: string): Promise<void> {
  return invoke<void>("set_profile_sync_mode", {
    profileId,
    syncMode: "Regular",
  });
}

/* -------------------------------------------------------------------------- */
/* Timezone                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The timezone the profile pretends to live in. The run is anchored to it so
 * a "02:00" enrolment means 02:00 where the identity claims to be, not where
 * the operator happens to be sitting. Falls back to this machine's zone.
 */
export function profileTimezone(profile: BrowserProfile): string {
  // Identity-backed profiles keep the exit's location in `location`; legacy
  // ones carry it inside the stored payload.
  const raw =
    profile.wayfern_config?.location ?? profile.wayfern_config?.fingerprint;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as WayfernFingerprintConfig;
      if (typeof parsed.timezone === "string" && parsed.timezone.length > 0) {
        return parsed.timezone;
      }
    } catch {
      // A fingerprint we cannot parse is not an error here — the local zone is
      // a correct, if less specific, anchor.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/* -------------------------------------------------------------------------- */
/* Run + session status                                                       */
/* -------------------------------------------------------------------------- */

export type StatusTone =
  | "success"
  | "warning"
  | "destructive"
  | "muted"
  | "live";

export function runStatusTone(status: string): StatusTone {
  switch (status) {
    case "succeeded":
      return "success";
    case "running":
    case "pending":
      return "live";
    case "partial":
    case "skipped":
      return "warning";
    case "failed":
      return "destructive";
    default:
      return "muted";
  }
}

export function runStatusLabel(t: TFunction, status: string): string {
  switch (status) {
    case "pending":
      return t("cookieBot.runStatus.pending");
    case "running":
      return t("cookieBot.runStatus.running");
    case "succeeded":
      return t("cookieBot.runStatus.succeeded");
    case "partial":
      return t("cookieBot.runStatus.partial");
    case "failed":
      return t("cookieBot.runStatus.failed");
    case "skipped":
      return t("cookieBot.runStatus.skipped");
    case "cancelled":
      return t("cookieBot.runStatus.cancelled");
    default:
      // The status vocabulary belongs to the server. One it adds after this
      // build renders as itself rather than as a blank cell.
      return status;
  }
}

/**
 * Every value of the server's `CookieBotOutcomeCode`, mapped to a translated
 * sentence.
 *
 * The code exists so a refusal is something a user can SEE in their history.
 * Printed raw it was a snake_case English token in ten locales: a Russian
 * operator asking why last night did nothing read "Причина: no_capacity".
 * A value newer than this build still falls through to its own name, which
 * beats a blank cell, but every code the server defines today has a sentence.
 */
export const OUTCOME_KEYS: Record<string, string> = {
  not_entitled: "cookieBot.outcome.notEntitled",
  sync_disabled: "cookieBot.outcome.syncDisabled",
  encrypted_sync: "cookieBot.outcome.encryptedSync",
  proxy_required: "cookieBot.outcome.proxyRequired",
  // An exit IS attached; it just only resolves on the user's own machine. The
  // server has returned this since the reachability check landed and this map
  // never learned it, so the one refusal whose fix is "use a public proxy"
  // printed as `proxy_local_only`.
  proxy_local_only: "cookieBot.outcome.proxyLocalOnly",
  touch_fingerprint: "cookieBot.outcome.touchFingerprint",
  platform_unsupported: "cookieBot.outcome.platformUnsupported",
  no_sites: "cookieBot.outcome.noSites",
  quota_exhausted: "cookieBot.outcome.quotaExhausted",
  profile_locked: "cookieBot.outcome.profileLocked",
  no_capacity: "cookieBot.outcome.noCapacity",
  manager_error: "cookieBot.outcome.managerError",
  budget_exceeded: "cookieBot.outcome.budgetExceeded",
  // The commonest real outcome of the five missing ones, and it was showing
  // the raw token every time.
  browsing_incomplete: "cookieBot.outcome.browsingIncomplete",
  // Three refusals raised on the remote host itself. Each is a PERMANENT
  // condition — an unsupported proxy, no synced copy, wrong OS — so the
  // sentence has to say what to change, not "try again tonight".
  proxy_unsupported: "cookieBot.outcome.proxyUnsupported",
  profile_not_synced: "cookieBot.outcome.profileNotSynced",
  profile_os_mismatch: "cookieBot.outcome.profileOsMismatch",
  cancelled_by_user: "cookieBot.outcome.cancelledByUser",
};

export function outcomeLabel(
  t: TFunction,
  code: string | null | undefined,
): string | null {
  if (!code) return null;
  const key = OUTCOME_KEYS[code];
  return key ? t(key) : t("cookieBot.outcome.unknown", { code });
}

/**
 * The three refusals only the saved-list routes can raise.
 *
 * They are absent from the shared `backendErrors` table, so
 * `translateBackendError` renders them through its unknown-code fallback: a
 * user who reuses a name would be told "Something went wrong:
 * COOKIE_BOT_TEMPLATE_NAME_TAKEN" instead of that the name is taken, in the one
 * dialog where the fix is a single keystroke. Everything else — a signed-out
 * desktop, an unreachable cloud — still goes through the shared translator.
 */
const TEMPLATE_ERROR_KEYS: Record<string, string> = {
  COOKIE_BOT_TEMPLATE_NAME_TAKEN: "cookieBot.enrol.templateNameTaken",
  COOKIE_BOT_INVALID_TEMPLATE_NAME: "cookieBot.enrol.templateNameInvalid",
  COOKIE_BOT_TEMPLATE_NOT_FOUND: "cookieBot.enrol.templateMissing",
};

export function templateErrorMessage(t: TFunction, error: unknown): string {
  const parsed = parseBackendError(error);
  const key = parsed ? TEMPLATE_ERROR_KEYS[parsed.code] : undefined;
  if (!key) return translateBackendError(t, error);
  const max = parsed?.params?.max;
  // The server does not always send a limit. Interpolating an empty string
  // rendered "a name of  characters or fewer", so fall back to wording that
  // does not need the number.
  if (key === "cookieBot.enrol.templateNameInvalid" && !max) {
    return t("cookieBot.enrol.templateNameInvalidNoMax");
  }
  return t(key, { max });
}

/**
 * The session state machine, named honestly. `provisioning -> ready -> live ->
 * closed`, with `error` reachable from any of the first three, is what the
 * backend actually reports; nothing here infers a phase the backend has not
 * sent.
 */
export function sessionPhaseLabel(
  t: TFunction,
  session: RemoteSessionState,
): string {
  switch (session.state) {
    case "provisioning":
      return t("cookieBot.status.provisioning");
    case "ready":
      return t("cookieBot.status.ready");
    case "live":
      return t("cookieBot.status.warming");
    case "closed":
      return t("cookieBot.status.finished");
    case "error":
      return t("cookieBot.status.failed");
    default:
      return session.state;
  }
}

export function sessionTone(session: RemoteSessionState): StatusTone {
  switch (session.state) {
    case "provisioning":
      return "warning";
    case "ready":
      return "live";
    case "live":
      return "success";
    case "closed":
      return "muted";
    // A session the fleet failed is not a session that quietly finished. It
    // read as an untranslated `error` beside the same grey dot as an idle one,
    // in the exact place a user checks whether last night worked.
    case "error":
      return "destructive";
    default:
      return "muted";
  }
}

/**
 * Why a session ended, when the backend named a reason.
 *
 * `close_reason` has been on the wire since the stream existed and nothing read
 * it, so a session that hit the session cap and one the user stopped looked
 * identical.
 */
export function sessionCloseReason(
  t: TFunction,
  session: RemoteSessionState,
): string | null {
  switch (session.close_reason) {
    case null:
    case undefined:
    case "":
      return null;
    case "stopped_by_user":
      return t("cookieBot.closeReason.stoppedByUser");
    case "max_duration":
      return t("cookieBot.closeReason.maxDuration");
    default:
      // The vocabulary is the fleet's and it grows. An unknown reason still
      // beats no reason, but it is labelled so it does not read as a sentence.
      return t("cookieBot.closeReason.other", { reason: session.close_reason });
  }
}

const TONE_DOT: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
  live: "bg-warning",
};

/**
 * The app's one status vocabulary: a bare dot, no chip and no background.
 * `pulse` is reserved for "a transfer is in progress", exactly as the sync dots
 * use it, so a pulsing dot always means the same thing.
 */
export function StatusDot({
  tone,
  pulse,
  className,
}: {
  tone: StatusTone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        TONE_DOT[tone],
        pulse && "animate-pulse",
        className,
      )}
    />
  );
}

const TONE_BADGE: Record<StatusTone, string> = {
  success: "bg-success/10 text-success-text",
  warning: "bg-warning/12 text-warning-text",
  destructive: "bg-destructive/10 text-destructive-text",
  muted: "bg-foreground/6 text-muted-foreground",
  live: "bg-primary/10 text-primary-text",
};

/**
 * A state with a word and an icon, tinted by tone. Long text truncates inside
 * the column it is given; pass `title` to keep the whole sentence reachable.
 */
export function StatusBadge({
  tone,
  icon: Icon,
  spin,
  children,
  className,
}: {
  tone: StatusTone;
  icon?: IconType;
  spin?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Badge
      variant="soft"
      className={cn(
        "h-6 max-w-full min-w-0 shrink gap-1.5 rounded-md px-2 font-normal",
        TONE_BADGE[tone],
        className,
      )}
    >
      {Icon && (
        <Icon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0",
            spin && "animate-spin motion-reduce:animate-none",
          )}
        />
      )}
      <span className="min-w-0 truncate">{children}</span>
    </Badge>
  );
}

/**
 * An icon action in a table row. It shows on row hover or focus; a refused
 * action stays visible on hover, dimmed, and its tooltip says why.
 */
export function RowAction({
  label,
  name,
  forbidden,
  forbiddenReason,
  destructive,
  onClick,
  children,
}: {
  label: string;
  /** The row's item; screen readers hear it after the label. */
  name?: string;
  forbidden?: boolean;
  forbiddenReason?: string;
  destructive?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="row-reveal inline-flex shrink-0">
          <Button
            variant="subtle"
            size="icon"
            className={cn(
              "size-7 rounded-lg",
              destructive &&
                "hover:bg-destructive/10 hover:text-destructive-text",
            )}
            aria-label={
              name ? t("tables.rowAction", { action: label, name }) : label
            }
            disabled={forbidden}
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {forbidden && forbiddenReason ? forbiddenReason : label}
      </TooltipContent>
    </Tooltip>
  );
}

const RUN_STATUS_ICON: Record<string, IconType> = {
  pending: LuClock,
  running: LuLoaderCircle,
  succeeded: LuCircleCheck,
  partial: LuCircleDashed,
  skipped: LuCircleSlash,
  failed: LuCircleX,
  cancelled: LuCircleStop,
};

/** A run's status in the shared vocabulary, as a badge. */
export function RunStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <StatusBadge
      tone={runStatusTone(status)}
      icon={RUN_STATUS_ICON[status] ?? LuCircleDashed}
      spin={status === "running"}
      className={className}
    >
      {runStatusLabel(t, status)}
    </StatusBadge>
  );
}

/* -------------------------------------------------------------------------- */
/* Numbers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A cookie delta. A gain reads as a gain, a loss reads with a real minus sign
 * (U+2212, not a hyphen), and "nothing happened" reads as an em dash instead of
 * a confident zero.
 */
export function CookieDelta({
  value,
  className,
}: {
  value: number | null | undefined;
  className?: string;
}) {
  if (value === null || value === undefined) {
    return (
      <span className={cn("text-muted-foreground", className)} aria-hidden>
        —
      </span>
    );
  }
  if (value === 0) {
    return (
      <span className={cn("text-muted-foreground", className)} aria-hidden>
        —
      </span>
    );
  }
  const positive = value > 0;
  return (
    <span
      className={cn(
        "tabular-nums",
        positive ? "text-chart-1" : "text-muted-foreground",
        className,
      )}
    >
      {positive ? `+${value}` : `−${Math.abs(value)}`}
    </span>
  );
}

/** One decimal, but only when it earns one: `4.7 h`, `128 h`, `199.8 h`. */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return "0";
  if (Number.isInteger(hours)) return String(hours);
  return hours.toFixed(1);
}

/* -------------------------------------------------------------------------- */
/* Remote hours                                                               */
/* -------------------------------------------------------------------------- */

function meterFill(usedRatio: number): string {
  if (usedRatio >= 1) return "bg-destructive";
  if (usedRatio >= 0.9) return "bg-warning";
  return "bg-foreground";
}

/**
 * The hours meter. The track renders at full opacity on the first paint with
 * the label already in place; only the numerals wait for the server. The fill
 * is a scaleX transform with `initial={false}` so the first frame is the true
 * value and never grows in — and the radius lives on the track, so the fill's
 * caps cannot flip shape halfway through a change.
 */
export function RemoteHoursMeter({
  quota,
  isLoading,
  variant = "compact",
  className,
}: {
  quota: RemoteHoursQuota | null;
  isLoading: boolean;
  variant?: "compact" | "full" | "inline";
  className?: string;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const granted = quota?.granted_hours ?? 0;
  const used = quota?.used_hours ?? 0;
  const remaining = quota?.remaining_hours ?? 0;
  const ratio = granted > 0 ? Math.min(1, Math.max(0, used / granted)) : 0;
  const resets = formatDate(quota?.period_end);

  const bar = (
    <div
      className={cn(
        "w-full overflow-hidden rounded-full",
        variant === "inline" ? "h-1" : "h-1.5",
        "bg-foreground/8",
      )}
    >
      <motion.div
        initial={false}
        animate={{ scaleX: ratio }}
        transition={
          reduceMotion
            ? { duration: 0 }
            : {
                duration: variant === "inline" ? 0.22 : 0.6,
                ease: MOTION_EASE_OUT,
              }
        }
        style={{ transformOrigin: "left", willChange: "transform" }}
        className={cn("h-full w-full", meterFill(ratio))}
      />
    </div>
  );

  if (variant === "inline") {
    return <div className={cn("w-full", className)}>{bar}</div>;
  }

  const meter = (
    <div
      data-slot="remote-hours-meter"
      className={cn(
        "flex w-44 cursor-default flex-col gap-1.5",
        variant === "full" && "w-full",
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-3 text-xs">
        {isLoading ? (
          <Skeleton className="h-3.5 w-20" />
        ) : (
          <TickingNumber
            value={remaining}
            format={(value) =>
              t("cookieBot.hours.left", {
                hours: formatHours(Math.round(value * 10) / 10),
              })
            }
            className={cn(
              "font-medium",
              ratio >= 1 ? "text-destructive-text" : "text-foreground",
            )}
          />
        )}
        {!isLoading && granted > 0 && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {t("cookieBot.hours.remainingOf", { total: formatHours(granted) })}
          </span>
        )}
      </div>
      {bar}
    </div>
  );

  if (isLoading || !resets) return meter;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{meter}</TooltipTrigger>
      <TooltipContent>
        {t("cookieBot.hours.used", {
          used: formatHours(Math.round(used * 10) / 10),
          total: formatHours(granted),
        })}
        {" · "}
        {t("cookieBot.hours.resets", { date: resets })}
      </TooltipContent>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/* Live sessions                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A ticking wall clock, only while something is actually running. Returns
 * `Date.now()` once a second; consumers render it into `tabular-nums` so a
 * changing digit never reflows the row.
 */
export function useSecondTicker(active: boolean): number {
  return useNow(1000, active);
}

/* -------------------------------------------------------------------------- */
/* Joins                                                                      */
/* -------------------------------------------------------------------------- */

export function indexProfiles(
  profiles: BrowserProfile[],
): Map<string, BrowserProfile> {
  return new Map(profiles.map((p) => [p.id, p]));
}

export function indexRunsBySession(
  runs: CookieBotRun[],
): Map<string, CookieBotRun> {
  const map = new Map<string, CookieBotRun>();
  for (const run of runs) {
    if (run.session_id) map.set(run.session_id, run);
  }
  return map;
}

export function indexRunsById(runs: CookieBotRun[]): Map<string, CookieBotRun> {
  return new Map(runs.map((run) => [run.id, run]));
}

/**
 * The name to print for a session. The local profile record wins because it is
 * what the operator renamed; the run row is the fallback for a teammate's
 * profile this machine has never held.
 */
export function sessionDisplayName(
  session: RemoteSessionState,
  profiles: Map<string, BrowserProfile>,
  run: CookieBotRun | undefined,
): string | null {
  if (session.profile_id) {
    const profile = profiles.get(session.profile_id);
    if (profile) return profile.name;
  }
  return run?.profile_name ?? null;
}

export function scheduleSortKey(schedule: CookieBotSchedule): number {
  return schedule.run_at_minute;
}

/**
 * The dot a stored enrolment gets.
 *
 * `blocked_by` outranks `enabled`: an armed schedule the server will refuse is
 * not a healthy one, and showing it green with a next-run time is how a
 * detached proxy stayed invisible until the run was skipped at 02:00.
 */
export function scheduleTone(schedule: CookieBotSchedule): StatusTone {
  if (!schedule.enabled) return "muted";
  return schedule.blocked_by ? "warning" : "success";
}

/** Why this enrolment cannot run next, translated, or null. */
export function scheduleBlockedReason(
  t: TFunction,
  schedule: CookieBotSchedule,
): string | null {
  if (!schedule.enabled) return null;
  return outcomeLabel(t, schedule.blocked_by);
}

/** Seconds a session has been alive, or null when the backend has not said. */
export function sessionElapsedSeconds(
  session: RemoteSessionState,
  now: number,
): number | null {
  const started = parseIso(session.started_at);
  if (!started) return null;
  const end = parseIso(session.ended_at)?.getTime() ?? now;
  return Math.max(0, Math.floor((end - started.getTime()) / 1000));
}

/**
 * Whether a run's per-site counters mean anything yet.
 *
 * `sites_visited`, `sites_failed` and `consent_dismissed` default to 0 and are
 * not always populated, so rendering the default as a fact told a paying user
 * their run visited "0 of 12 sites" and drew a success-green progress bar
 * pinned at zero for the whole night.
 *
 * So a run is only credited with counters once one of them is non-zero. Until
 * then the UI says it does not know, which is the truth, and it reports real
 * numbers as soon as any arrive.
 */
export function hasRunCounters(run: {
  sites_visited: number;
  sites_failed: number;
  consent_dismissed: number;
}): boolean {
  return (
    run.sites_visited > 0 || run.sites_failed > 0 || run.consent_dismissed > 0
  );
}

/**
 * Runs whose schedule fires on the next occurrence of their local start time.
 * Purely a read of the server's own `next_run_at` — nothing here computes a
 * schedule, it only sorts what the server already decided.
 */
export function sortByNextRun(
  schedules: CookieBotSchedule[],
): CookieBotSchedule[] {
  return [...schedules].sort((a, b) => {
    const at = parseIso(a.next_run_at)?.getTime();
    const bt = parseIso(b.next_run_at)?.getTime();
    if (at !== undefined && bt !== undefined) return at - bt;
    if (at !== undefined) return -1;
    if (bt !== undefined) return 1;
    return scheduleSortKey(a) - scheduleSortKey(b);
  });
}

/**
 * The next enrolment the server will start, and how many start within a day.
 * A blocked enrolment is left out: its next run is one the server will refuse.
 */
export function useNextDue(schedules: CookieBotSchedule[], now: number) {
  return useMemo(() => {
    const enabled = schedules.filter((s) => s.enabled);
    const runnable = enabled.filter((s) => !s.blocked_by);
    const sorted = sortByNextRun(runnable);
    const first = sorted[0] ?? null;
    const firstAt = parseIso(first?.next_run_at ?? null);
    const dayAhead = now + 24 * 60 * 60 * 1000;
    const dueCount = sorted.filter((s) => {
      const at = parseIso(s.next_run_at);
      return at !== null && at.getTime() <= dayAhead;
    }).length;
    return {
      next: first,
      nextAt: firstAt,
      dueCount,
      allBlocked: enabled.length > 0 && runnable.length === 0,
    };
  }, [schedules, now]);
}
