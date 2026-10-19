import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BrowserProfile,
  GroupWithCount,
  StoredProxy,
  VpnConfig,
} from "@/types";

/**
 * How long a loaded list is good for a new reader with no change event in
 * between. A dialog that opens just after the page loaded the list reuses it.
 */
export const REUSE_MS = 300;

export interface SharedListener<T> {
  value: (value: T) => void;
  error?: (error: unknown) => void;
}

export interface SharedResource<T> {
  /** The last loaded value, if any. */
  peek(): T | undefined;
  /**
   * The value, from a load already in flight or one that finished less than
   * `reuseMs` ago with no change since; otherwise a new load.
   */
  load(): Promise<T>;
  /** A new load: nothing loaded before this call is reused. */
  refresh(): Promise<T>;
  /**
   * Called with every newly loaded value. While anyone listens, the change
   * events reload the value once for all of them.
   */
  subscribe(listener: SharedListener<T>): () => void;
}

interface ResourceOptions {
  /** Backend events after which the value is out of date. */
  events?: readonly string[];
  reuseMs?: number;
  now?: () => number;
  /** Subscribes to a backend event; returns the unsubscribe. */
  listenTo?: (event: string, onEvent: () => void) => Promise<() => void>;
}

const tauriListen = (event: string, onEvent: () => void) =>
  listen(event, onEvent);

/**
 * One value that many components read, loaded once for all of them. Loads
 * that overlap share one call; a load that started before a change never
 * replaces one that started after it.
 */
export function createSharedResource<T>(
  fetch: () => Promise<T>,
  {
    events = [],
    reuseMs = REUSE_MS,
    now = () => Date.now(),
    listenTo = tauriListen,
  }: ResourceOptions = {},
): SharedResource<T> {
  // Bumped by every change: a load or a value from an older generation is
  // out of date.
  let generation = 0;
  let inFlight: { generation: number; promise: Promise<T> } | null = null;
  let last: { generation: number; at: number; value: T } | null = null;
  const listeners = new Set<SharedListener<T>>();
  let unlisteners: Promise<() => void>[] = [];
  // A change came in while a load ran: load once more when it ends.
  let queued = false;

  const start = (): Promise<T> => {
    const started = generation;
    // This load starts after every change so far.
    queued = false;
    const settle = () => {
      if (inFlight?.promise !== promise) return;
      inFlight = null;
      if (queued) start().catch(() => undefined);
    };
    const promise = fetch().then(
      (value) => {
        settle();
        if (!last || started >= last.generation) {
          last = { generation: started, at: now(), value };
          for (const listener of listeners) listener.value(value);
        }
        // A newer load may have finished first: every caller gets the
        // newest value, never an older one that would overwrite it.
        return last.value;
      },
      (error: unknown) => {
        settle();
        for (const listener of listeners) listener.error?.(error);
        throw error;
      },
    );
    inFlight = { generation: started, promise };
    return promise;
  };

  const load = (): Promise<T> => {
    if (inFlight && inFlight.generation === generation) {
      return inFlight.promise;
    }
    if (last && last.generation === generation && now() - last.at < reuseMs) {
      return Promise.resolve(last.value);
    }
    return start();
  };

  const refresh = (): Promise<T> => {
    generation += 1;
    return start();
  };

  // A burst of change events costs at most two loads: the one running and
  // one after it. Listeners hear the result, and errors, through `subscribe`.
  const onChange = () => {
    generation += 1;
    if (inFlight) {
      queued = true;
      return;
    }
    start().catch(() => undefined);
  };

  return {
    peek: () => last?.value,
    load,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        unlisteners = events.map((event) =>
          listenTo(event, onChange).catch((error: unknown) => {
            console.error(`Failed to listen for ${event}:`, error);
            return () => undefined;
          }),
        );
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        for (const unlisten of unlisteners) {
          void unlisten.then((stop) => stop());
        }
        unlisteners = [];
        // Nobody hears the change events now: the next reader loads again.
        generation += 1;
      };
    },
  };
}

/** Every profile's metadata. One `profiles-changed` reloads it once. */
export const profileList = createSharedResource(
  () => invoke<BrowserProfile[]>("list_browser_profiles"),
  { events: ["profiles-changed"] },
);

/** Groups with their profile counts, which change with the profiles. */
export const groupList = createSharedResource(
  () => invoke<GroupWithCount[]>("get_groups_with_profile_counts"),
  { events: ["groups-changed", "profiles-changed"] },
);

export const storedProxyList = createSharedResource(
  () => invoke<StoredProxy[]>("get_stored_proxies"),
  { events: ["proxies-changed", "stored-proxies-changed"] },
);

export const vpnConfigList = createSharedResource(
  () => invoke<VpnConfig[]>("list_vpn_configs"),
  { events: ["vpn-configs-changed"] },
);

/**
 * How many profiles use each id that `key` returns. Returns `previous` when
 * the counts are the same, so a reader re-renders only for a real change.
 */
export function countBy<P>(
  items: readonly P[],
  key: (item: P) => string | null | undefined,
  previous?: Record<string, number>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const id = key(item);
    if (id) counts[id] = (counts[id] ?? 0) + 1;
  }
  if (previous && sameCounts(previous, counts)) return previous;
  return counts;
}

function sameCounts(a: Record<string, number>, b: Record<string, number>) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

/**
 * `previous` when it holds the same ids as `next`, else `next`: a Set read in
 * effect dependencies keeps its identity while its members do not change.
 */
export function sameSetOr(
  previous: Set<string>,
  next: Set<string>,
): Set<string> {
  if (previous.size !== next.size) return next;
  for (const id of next) if (!previous.has(id)) return next;
  return previous;
}
