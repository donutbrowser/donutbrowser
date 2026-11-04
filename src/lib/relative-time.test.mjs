import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration, formatTimeAgo } from "./relative-time.ts";

test("a time ago takes the largest whole unit", () => {
  const now = 1_000_000;
  assert.equal(formatTimeAgo(now - 30, now, "en"), "now");
  assert.equal(formatTimeAgo(now - 5 * 60, now, "en"), "5 minutes ago");
  assert.equal(formatTimeAgo(now - 3 * 3600 - 59, now, "en"), "3 hours ago");
  assert.equal(formatTimeAgo(now - 86_400, now, "en"), "yesterday");
  assert.equal(formatTimeAgo(now - 3 * 86_400, now, "fr"), "il y a 3 jours");
});

test("a duration keeps two units at most, to the minute", () => {
  assert.equal(formatDuration(40, "en"), "0 min");
  assert.equal(formatDuration(5 * 60, "en"), "5 min");
  assert.equal(formatDuration(2 * 3600, "en"), "2 hr");
  assert.equal(formatDuration(2 * 3600 + 5 * 60 + 59, "en"), "2 hr, 5 min");
  assert.equal(
    formatDuration(3 * 86_400 + 4 * 3600 + 7 * 60, "en"),
    "3 days, 4 hr",
  );
  assert.equal(formatDuration(-10, "en"), "0 min");
});
