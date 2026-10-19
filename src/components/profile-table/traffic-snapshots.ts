import type { TrafficSnapshot } from "@/types";

/** How often running rows read their traffic while the window shows. */
export const TRAFFIC_POLL_MS = 2000;

/**
 * The newest snapshot of each running profile. Snapshots of profiles that
 * do not run, or that name no profile, are left out.
 */
export function latestSnapshots(
  snapshots: readonly TrafficSnapshot[],
  running: ReadonlySet<string>,
): Map<string, TrafficSnapshot> {
  const latest = new Map<string, TrafficSnapshot>();
  for (const snapshot of snapshots) {
    const id = snapshot.profile_id;
    if (!id || !running.has(id)) continue;
    const existing = latest.get(id);
    if (!existing || snapshot.last_update > existing.last_update) {
      latest.set(id, snapshot);
    }
  }
  return latest;
}

/** Whether `next` shows anything `previous` did not. */
export function sameSnapshot(
  previous: TrafficSnapshot | undefined,
  next: TrafficSnapshot | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  return (
    previous.last_update === next.last_update &&
    previous.total_bytes_sent === next.total_bytes_sent &&
    previous.total_bytes_received === next.total_bytes_received &&
    previous.current_bytes_sent === next.current_bytes_sent &&
    previous.current_bytes_received === next.current_bytes_received &&
    previous.recent_bandwidth.length === next.recent_bandwidth.length
  );
}

/**
 * Live traffic per running profile, outside React state: a poll tells only
 * the rows whose snapshot changed, so the table itself never re-renders for
 * traffic.
 */
export class TrafficSnapshotStore {
  private snapshots = new Map<string, TrafficSnapshot>();
  private listeners = new Map<string, Set<() => void>>();

  get = (profileId: string): TrafficSnapshot | undefined =>
    this.snapshots.get(profileId);

  subscribe = (profileId: string, listener: () => void): (() => void) => {
    let set = this.listeners.get(profileId);
    if (!set) {
      set = new Set();
      this.listeners.set(profileId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(profileId);
    };
  };

  /**
   * Takes a poll's snapshots. An unchanged snapshot keeps the object a row
   * already holds; returns the ids whose snapshot changed.
   */
  update(
    snapshots: readonly TrafficSnapshot[],
    running: ReadonlySet<string>,
  ): string[] {
    const latest = latestSnapshots(snapshots, running);
    const changed: string[] = [];
    const next = new Map<string, TrafficSnapshot>();
    for (const [id, snapshot] of latest) {
      const previous = this.snapshots.get(id);
      if (sameSnapshot(previous, snapshot) && previous) {
        next.set(id, previous);
      } else {
        next.set(id, snapshot);
        changed.push(id);
      }
    }
    for (const id of this.snapshots.keys()) {
      if (!next.has(id)) changed.push(id);
    }
    this.snapshots = next;
    this.notify(changed);
    return changed;
  }

  /** Drops the snapshots of profiles that stopped. */
  retain(running: ReadonlySet<string>): void {
    const gone = [...this.snapshots.keys()].filter((id) => !running.has(id));
    for (const id of gone) this.snapshots.delete(id);
    this.notify(gone);
  }

  private notify(ids: readonly string[]) {
    for (const id of ids) {
      for (const listener of this.listeners.get(id) ?? []) listener();
    }
  }
}
