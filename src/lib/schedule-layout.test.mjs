import assert from "node:assert/strict";
import test from "node:test";
import {
  DAY_MINUTES,
  daySegments,
  MIN_SLOT_GAP_MINUTES,
  minutesApart,
  pickRunMinute,
  pickRunMinutes,
  scheduleLanes,
  scheduleSlots,
} from "./schedule-layout.ts";

/** A seeded generator, so a failure names the sequence that caused it. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("distance between times wraps round midnight", () => {
  assert.equal(minutesApart(10, 1430), 20);
  assert.equal(minutesApart(1430, 10), 20);
  assert.equal(minutesApart(600, 600), 0);
  assert.equal(minutesApart(0, 720), 720);
});

test("every minute of the day is equally likely", () => {
  const random = seeded(7);
  const hours = new Array(24).fill(0);
  const minutesOfHour = new Array(60).fill(0);
  const draws = 36_000;
  for (let index = 0; index < draws; index++) {
    const minute = pickRunMinute([], { random });
    assert.ok(Number.isInteger(minute) && minute >= 0 && minute < DAY_MINUTES);
    hours[Math.floor(minute / 60)] += 1;
    minutesOfHour[minute % 60] += 1;
  }
  for (const [hour, n] of hours.entries()) {
    assert.ok(Math.abs(n / draws - 1 / 24) < 0.005, `hour ${hour} drew ${n}`);
  }
  for (const [minute, n] of minutesOfHour.entries()) {
    assert.ok(
      Math.abs(n / draws - 1 / 60) < 0.005,
      `minute :${minute} drew ${n}`,
    );
  }
});

test("a picked time keeps its distance from the times already taken", () => {
  const random = seeded(11);
  for (let index = 0; index < 500; index++) {
    const taken = [Math.floor(random() * DAY_MINUTES)];
    const minute = pickRunMinute(taken, { random });
    assert.ok(minutesApart(minute, taken[0]) >= MIN_SLOT_GAP_MINUTES);
  }
  const several = pickRunMinutes(14, { random });
  for (const [index, minute] of several.entries()) {
    for (const other of several.slice(index + 1)) {
      assert.ok(minutesApart(minute, other) >= MIN_SLOT_GAP_MINUTES);
    }
  }
});

test("a full day still yields the freest minute instead of failing", () => {
  const taken = Array.from({ length: 24 }, (_, hour) => hour * 60);
  const minute = pickRunMinute(taken, { random: seeded(3) });
  assert.equal(minute % 60, 30);
});

test("a run that passes midnight is drawn on both ends of the day", () => {
  assert.deepEqual(daySegments(600, 30), [{ start: 600, end: 630 }]);
  assert.deepEqual(daySegments(1420, 40), [
    { start: 1420, end: 1440 },
    { start: 0, end: 20 },
  ]);
});

function booking(profile_id, minute, options = {}) {
  return {
    profile_id,
    profile_name: profile_id,
    enabled: true,
    timezone: "UTC",
    days_mask: 127,
    run_at_minute: minute,
    max_minutes: 30,
    ...options,
  };
}

test("all slots survive, coincident weekdays merge, and legacy schedules still render", () => {
  const legacy = booking("legacy", 90);
  assert.deepEqual(scheduleSlots(legacy), [
    { days_mask: 127, run_at_minute: 90 },
  ]);
  const multi = booking("multiple", 120, {
    slots: [
      { days_mask: 1, run_at_minute: 120 },
      { days_mask: 2, run_at_minute: 120 },
      { days_mask: 127, run_at_minute: 600 },
    ],
  });
  const lanes = scheduleLanes([legacy, multi]).get("UTC");
  assert.deepEqual(
    lanes.map(({ minute, days }) => [minute, days]),
    [
      [90, 127],
      [120, 3],
      [600, 127],
    ],
  );
  assert.equal(lanes[0].overlaps, 0, "adjacent reservations do not overlap");
});

test("overlaps honor weekday masks, disabled and blocked schedules, and timezone boundaries", () => {
  const lanes = scheduleLanes([
    booking("monday", 120, { days_mask: 1 }),
    booking("same", 135, { days_mask: 1 }),
    booking("tuesday", 135, { days_mask: 2 }),
    booking("disabled", 130, { enabled: false }),
    booking("blocked", 130, { blocked_by: "no_proxy" }),
    booking("other-zone", 135, { timezone: "Asia/Yerevan" }),
  ]);
  assert.deepEqual(
    Object.fromEntries(
      lanes.get("UTC").map((lane) => [lane.schedule.profile_id, lane.overlaps]),
    ),
    { monday: 1, blocked: 0, disabled: 0, same: 1, tuesday: 0 },
  );
  assert.equal(lanes.get("Asia/Yerevan")[0].overlaps, 0);
});

test("Sunday reservations crossing midnight overlap Monday without inventing daily conflicts", () => {
  const lanes = scheduleLanes([
    booking("sunday", 1430, { days_mask: 64 }),
    booking("monday", 5, { days_mask: 1 }),
    booking("tuesday", 5, { days_mask: 2 }),
  ]).get("UTC");
  assert.equal(
    lanes.find((lane) => lane.schedule.profile_id === "sunday").overlaps,
    1,
  );
  assert.equal(
    lanes.find((lane) => lane.schedule.profile_id === "tuesday").overlaps,
    0,
  );
});

test("a confirmed reschedule keeps its visual identity", () => {
  const before = scheduleLanes([booking("same", 120)]).get("UTC")[0];
  const after = scheduleLanes([booking("same", 180)]).get("UTC")[0];
  assert.equal(before.id, after.id);
  assert.notEqual(before.minute, after.minute);
});
