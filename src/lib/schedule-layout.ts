import type { CookieBotSchedule, CookieBotSlot } from "./cookie-bot";

export const DAY_MINUTES = 1440;

/** The least distance between two start times of one enrolment that the app picks. */
export const MIN_SLOT_GAP_MINUTES = 60;

/** Minutes between two times of day, the short way round midnight. */
export function minutesApart(a: number, b: number): number {
  const distance =
    (((Math.round(a) - Math.round(b)) % DAY_MINUTES) + DAY_MINUTES) %
    DAY_MINUTES;
  return Math.min(distance, DAY_MINUTES - distance);
}

/**
 * A random minute of the day, at least `gap` minutes from every `taken` time.
 *
 * Every allowed minute is equally likely. When no minute keeps the gap, the
 * pick is among the minutes farthest from the others.
 */
export function pickRunMinute(
  taken: readonly number[] = [],
  {
    gap = MIN_SLOT_GAP_MINUTES,
    random = Math.random,
  }: { gap?: number; random?: () => number } = {},
): number {
  let best = -1;
  let candidates: number[] = [];
  for (let minute = 0; minute < DAY_MINUTES; minute++) {
    let nearest = DAY_MINUTES;
    for (const other of taken) {
      nearest = Math.min(nearest, minutesApart(minute, other));
    }
    const score = Math.min(nearest, gap);
    if (score > best) {
      best = score;
      candidates = [minute];
    } else if (score === best) {
      candidates.push(minute);
    }
  }
  const index = Math.min(
    candidates.length - 1,
    Math.floor(random() * candidates.length),
  );
  return candidates[index];
}

/** `count` random minutes, each at least `gap` minutes from the others. */
export function pickRunMinutes(
  count: number,
  options: { gap?: number; random?: () => number } = {},
): number[] {
  const picked: number[] = [];
  for (let index = 0; index < count; index++) {
    picked.push(pickRunMinute(picked, options));
  }
  return picked;
}

/**
 * Where a run sits on a 24-hour track: one segment, or two when it continues
 * past midnight.
 */
export function daySegments(
  minute: number,
  duration: number,
): { start: number; end: number }[] {
  const start =
    ((Math.round(minute) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const length = Math.min(DAY_MINUTES, Math.max(0, duration));
  const end = start + length;
  if (end <= DAY_MINUTES) return [{ start, end }];
  return [
    { start, end: DAY_MINUTES },
    { start: 0, end: end - DAY_MINUTES },
  ];
}

export function scheduleSlots(schedule: {
  slots?: CookieBotSlot[];
  run_at_minute: number;
  days_mask: number;
}): CookieBotSlot[] {
  return schedule.slots?.length
    ? schedule.slots
    : [
        {
          days_mask: schedule.days_mask,
          run_at_minute: schedule.run_at_minute,
        },
      ];
}

export interface ScheduleLane {
  id: string;
  schedule: CookieBotSchedule;
  minute: number;
  days: number;
  duration: number;
  overlaps: number;
}

function intersects(a: ScheduleLane, b: ScheduleLane): boolean {
  if (
    !a.schedule.enabled ||
    !b.schedule.enabled ||
    a.schedule.blocked_by ||
    b.schedule.blocked_by
  )
    return false;
  for (let day = 0; day < 7; day++) {
    if (!(a.days & (1 << day))) continue;
    const start = day * 1440 + a.minute;
    for (let otherDay = 0; otherDay < 7; otherDay++) {
      if (!(b.days & (1 << otherDay))) continue;
      for (const week of [-10080, 0, 10080]) {
        const otherStart = otherDay * 1440 + b.minute + week;
        if (start < otherStart + b.duration && otherStart < start + a.duration)
          return true;
      }
    }
  }
  return false;
}

/** Wall-clock reservations are compared only within the same timezone. */
export function scheduleLanes(
  schedules: CookieBotSchedule[],
): Map<string, ScheduleLane[]> {
  const groups = new Map<string, ScheduleLane[]>();
  for (const schedule of schedules) {
    const lanes = groups.get(schedule.timezone) ?? [];
    // Coincident slots dispatch once, even when their weekday masks overlap.
    const minutes = new Map<number, number>();
    for (const slot of scheduleSlots(schedule)) {
      minutes.set(
        slot.run_at_minute,
        (minutes.get(slot.run_at_minute) ?? 0) | slot.days_mask,
      );
    }
    let slotIndex = 0;
    for (const [minute, days] of minutes) {
      lanes.push({
        id: `${schedule.owner_user_id ?? ""}:${schedule.profile_id}:${slotIndex++}`,
        schedule,
        minute,
        days,
        duration: Math.max(0, schedule.max_minutes),
        overlaps: 0,
      });
    }
    groups.set(schedule.timezone, lanes);
  }
  for (const lanes of groups.values()) {
    lanes.sort(
      (a, b) =>
        a.minute - b.minute ||
        a.schedule.profile_name.localeCompare(b.schedule.profile_name),
    );
    for (let index = 0; index < lanes.length; index++) {
      for (let other = index + 1; other < lanes.length; other++) {
        if (intersects(lanes[index], lanes[other])) {
          lanes[index].overlaps++;
          lanes[other].overlaps++;
        }
      }
    }
  }
  return groups;
}
