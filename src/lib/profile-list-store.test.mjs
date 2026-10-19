import assert from "node:assert/strict";
import test from "node:test";
import {
  countBy,
  createSharedResource,
  REUSE_MS,
  sameSetOr,
} from "./profile-list-store.ts";

/** A fetch whose calls the test resolves by hand. */
function controlledFetch() {
  const calls = [];
  const fetch = () =>
    new Promise((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return { calls, fetch };
}

/** An event bus standing in for the backend's events. */
function fakeEvents() {
  const handlers = new Map();
  return {
    listenTo: async (event, onEvent) => {
      const list = handlers.get(event) ?? new Set();
      list.add(onEvent);
      handlers.set(event, list);
      return () => list.delete(onEvent);
    },
    emit: (event) => {
      for (const handler of handlers.get(event) ?? []) handler();
    },
    count: (event) => handlers.get(event)?.size ?? 0,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("readers that load at the same time share one call", async () => {
  const { calls, fetch } = controlledFetch();
  const resource = createSharedResource(fetch, {
    listenTo: fakeEvents().listenTo,
  });
  const reads = [resource.load(), resource.load(), resource.load()];
  assert.equal(calls.length, 1);
  calls[0].resolve(["a"]);
  const values = await Promise.all(reads);
  for (const value of values) assert.equal(value, values[0]);
});

test("a fresh result is reused, an old one is loaded again", async () => {
  let clock = 1000;
  const { calls, fetch } = controlledFetch();
  const resource = createSharedResource(fetch, {
    now: () => clock,
    listenTo: fakeEvents().listenTo,
  });
  const first = resource.load();
  calls[0].resolve(["a"]);
  const value = await first;
  clock += REUSE_MS - 1;
  assert.equal(await resource.load(), value);
  assert.equal(calls.length, 1);
  clock += 2;
  void resource.load();
  assert.equal(calls.length, 2);
});

test("one change event loads once for every listener", async () => {
  const events = fakeEvents();
  const { calls, fetch } = controlledFetch();
  const resource = createSharedResource(fetch, {
    events: ["profiles-changed"],
    listenTo: events.listenTo,
  });
  const heard = [];
  for (let i = 0; i < 4; i++) {
    resource.subscribe({ value: (value) => heard.push(value) });
  }
  await tick();
  assert.equal(events.count("profiles-changed"), 1, "one backend listener");
  events.emit("profiles-changed");
  assert.equal(calls.length, 1);
  calls[0].resolve(["b"]);
  await tick();
  assert.equal(heard.length, 4);
  assert.ok(heard.every((value) => value === heard[0]));
});

test("a change during a load is never answered by that load alone", async () => {
  const events = fakeEvents();
  const { calls, fetch } = controlledFetch();
  const resource = createSharedResource(fetch, {
    events: ["profiles-changed"],
    listenTo: events.listenTo,
  });
  const heard = [];
  resource.subscribe({ value: (value) => heard.push(value) });
  await tick();
  void resource.load();
  events.emit("profiles-changed");
  events.emit("profiles-changed");
  events.emit("profiles-changed");
  assert.equal(calls.length, 1, "the burst waits for the running load");
  calls[0].resolve(["old"]);
  await tick();
  assert.equal(calls.length, 2, "then loads once more");
  calls[1].resolve(["new"]);
  await tick();
  assert.deepEqual(heard.at(-1), ["new"]);
  // A reader after the change gets the newer value, not the older one.
  assert.deepEqual(await resource.load(), ["new"]);
});

test("refresh never reuses what was loaded before it", async () => {
  const { calls, fetch } = controlledFetch();
  const resource = createSharedResource(fetch, {
    listenTo: fakeEvents().listenTo,
  });
  const before = resource.load();
  const after = resource.refresh();
  assert.equal(calls.length, 2);
  calls[1].resolve(["new"]);
  calls[0].resolve(["old"]);
  assert.deepEqual(await after, ["new"]);
  assert.deepEqual(await before, ["new"], "its caller gets the newer value");
  assert.deepEqual(resource.peek(), ["new"], "an older load does not win");
});

test("errors reach listeners and the caller", async () => {
  const { calls, fetch } = controlledFetch();
  const resource = createSharedResource(fetch, {
    listenTo: fakeEvents().listenTo,
  });
  const errors = [];
  resource.subscribe({ value: () => {}, error: (error) => errors.push(error) });
  const read = resource.load();
  calls[0].reject(new Error("boom"));
  await assert.rejects(read, /boom/);
  assert.equal(errors.length, 1);
  // The failed load is not reused.
  void resource.load();
  assert.equal(calls.length, 2);
});

test("the last listener leaving stops listening and drops the cache", async () => {
  const events = fakeEvents();
  const { calls, fetch } = controlledFetch();
  const resource = createSharedResource(fetch, {
    events: ["profiles-changed"],
    listenTo: events.listenTo,
  });
  const stop = resource.subscribe({ value: () => {} });
  const read = resource.load();
  calls[0].resolve(["a"]);
  await read;
  stop();
  await tick();
  assert.equal(events.count("profiles-changed"), 0);
  void resource.load();
  assert.equal(calls.length, 2, "an unwatched value is not trusted");
});

test("counts keep their identity when nothing changed", () => {
  const profiles = [{ proxy_id: "p1" }, { proxy_id: "p1" }, { proxy_id: "p2" }];
  const counts = countBy(profiles, (profile) => profile.proxy_id);
  assert.deepEqual(counts, { p1: 2, p2: 1 });
  assert.equal(
    countBy([...profiles], (profile) => profile.proxy_id, counts),
    counts,
  );
  const changed = countBy(
    [...profiles, { proxy_id: "p2" }],
    (profile) => profile.proxy_id,
    counts,
  );
  assert.deepEqual(changed, { p1: 2, p2: 2 });
});

test("a set with the same members keeps its identity", () => {
  const previous = new Set(["a", "b"]);
  assert.equal(sameSetOr(previous, new Set(["b", "a"])), previous);
  const next = new Set(["a", "c"]);
  assert.equal(sameSetOr(previous, next), next);
});
