import assert from "node:assert/strict";
import test from "node:test";
import {
  latestSnapshots,
  sameSnapshot,
  TrafficSnapshotStore,
} from "./traffic-snapshots.ts";

function snapshot(profileId, lastUpdate, current = 0) {
  return {
    profile_id: profileId,
    session_start: 0,
    last_update: lastUpdate,
    total_bytes_sent: current,
    total_bytes_received: current,
    total_requests: 0,
    current_bytes_sent: current,
    current_bytes_received: 0,
    recent_bandwidth: [],
  };
}

test("only the newest snapshot of a running profile is kept", () => {
  const latest = latestSnapshots(
    [
      snapshot("a", 5),
      snapshot("a", 9),
      snapshot("a", 7),
      snapshot("b", 3),
      snapshot(undefined, 10),
    ],
    new Set(["a"]),
  );
  assert.deepEqual([...latest.keys()], ["a"]);
  assert.equal(latest.get("a").last_update, 9);
});

test("a snapshot with the same time and totals is the same", () => {
  assert.ok(sameSnapshot(snapshot("a", 5, 10), snapshot("a", 5, 10)));
  assert.ok(!sameSnapshot(snapshot("a", 5, 10), snapshot("a", 6, 10)));
  assert.ok(!sameSnapshot(snapshot("a", 5, 10), snapshot("a", 5, 11)));
  assert.ok(!sameSnapshot(undefined, snapshot("a", 5)));
});

test("a poll tells only the rows whose traffic changed", () => {
  const store = new TrafficSnapshotStore();
  const running = new Set(["a", "b"]);
  const heard = { a: 0, b: 0 };
  store.subscribe("a", () => heard.a++);
  store.subscribe("b", () => heard.b++);

  store.update([snapshot("a", 1), snapshot("b", 1)], running);
  assert.deepEqual(heard, { a: 1, b: 1 });
  const held = store.get("a");

  // The same numbers again: nobody re-renders, and the object stays.
  assert.deepEqual(
    store.update([snapshot("a", 1), snapshot("b", 1)], running),
    [],
  );
  assert.equal(store.get("a"), held);
  assert.deepEqual(heard, { a: 1, b: 1 });

  // Only b moved.
  assert.deepEqual(
    store.update([snapshot("a", 1), snapshot("b", 2, 50)], running),
    ["b"],
  );
  assert.deepEqual(heard, { a: 1, b: 2 });
});

test("a profile that stops loses its snapshot and is told", () => {
  const store = new TrafficSnapshotStore();
  let heard = 0;
  store.subscribe("a", () => heard++);
  store.update([snapshot("a", 1)], new Set(["a"]));
  store.retain(new Set());
  assert.equal(store.get("a"), undefined);
  assert.equal(heard, 2);
  // A snapshot missing from a poll is dropped too.
  store.update([snapshot("a", 2)], new Set(["a"]));
  store.update([], new Set(["a"]));
  assert.equal(store.get("a"), undefined);
});

test("unsubscribing stops the calls", () => {
  const store = new TrafficSnapshotStore();
  let heard = 0;
  const stop = store.subscribe("a", () => heard++);
  stop();
  store.update([snapshot("a", 1)], new Set(["a"]));
  assert.equal(heard, 0);
});
