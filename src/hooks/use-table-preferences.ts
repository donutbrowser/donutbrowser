"use client";

import type {
  ColumnSizingState,
  ColumnVisibilityState,
  SortingState,
  Updater,
} from "@tanstack/react-table";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { translateBackendError } from "@/lib/backend-errors";
import type { TableId } from "@/lib/table-tools";
import type { SavedTableView, StoredTablePreferences } from "@/lib/table-views";

const DEFAULT_PREFERENCES: StoredTablePreferences = {
  visibility: {},
  sizing: {},
  sorting: [{ id: "name", desc: false }],
  density: "compact",
};
const SAVE_DELAY_MS = 180;

interface Snapshot {
  preferences: StoredTablePreferences;
  loaded: boolean;
  error: unknown;
}

/**
 * One store per table, shared by every component that shows or changes that
 * table's preferences, so the table, its controls and its saved views never
 * hold diverging copies.
 */
interface Store {
  snapshot: Snapshot;
  listeners: Set<() => void>;
  loading: boolean;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  write: Promise<unknown>;
}

const stores = new Map<TableId, Store>();
const SERVER_SNAPSHOT: Snapshot = {
  preferences: DEFAULT_PREFERENCES,
  loaded: false,
  error: null,
};

function storeFor(id: TableId): Store {
  let store = stores.get(id);
  if (!store) {
    store = {
      snapshot: SERVER_SNAPSHOT,
      listeners: new Set(),
      loading: false,
      dirty: false,
      timer: null,
      write: Promise.resolve(),
    };
    stores.set(id, store);
  }
  return store;
}

function publish(store: Store, change: Partial<Snapshot>) {
  store.snapshot = { ...store.snapshot, ...change };
  for (const listener of store.listeners) listener();
}

function load(id: TableId) {
  const store = storeFor(id);
  if (store.loading || store.snapshot.loaded) return;
  store.loading = true;
  if (store.snapshot.error) publish(store, { error: null });
  void store.write
    .catch(() => {})
    .then(() =>
      invoke<StoredTablePreferences>("get_table_preferences", { tableId: id }),
    )
    .then((preferences) => {
      publish(store, { preferences, loaded: true, error: null });
    })
    .catch((error: unknown) => {
      publish(store, { error });
    })
    .finally(() => {
      store.loading = false;
    });
}

function save(id: TableId) {
  const store = storeFor(id);
  if (store.timer !== null) clearTimeout(store.timer);
  store.timer = null;
  const preferences = store.snapshot.preferences;
  store.write = store.write
    .catch(() => {})
    .then(() => invoke("save_table_preferences", { tableId: id, preferences }))
    .then(() => {
      if (store.snapshot.preferences === preferences) store.dirty = false;
      if (store.snapshot.error) publish(store, { error: null });
    })
    .catch((error: unknown) => {
      publish(store, { error });
    });
}

function change(
  id: TableId,
  next: (previous: StoredTablePreferences) => StoredTablePreferences,
) {
  const store = storeFor(id);
  if (!store.snapshot.loaded) return;
  store.dirty = true;
  publish(store, { preferences: next(store.snapshot.preferences) });
  if (store.timer !== null) clearTimeout(store.timer);
  store.timer = setTimeout(() => save(id), SAVE_DELAY_MS);
}

function resolve<T>(value: Updater<T>, previous: T): T {
  return typeof value === "function"
    ? (value as (old: T) => T)(previous)
    : value;
}

export function useTablePreferences(id: TableId) {
  const { t } = useTranslation();
  const subscribe = useCallback(
    (listener: () => void) => {
      const store = storeFor(id);
      store.listeners.add(listener);
      load(id);
      return () => {
        store.listeners.delete(listener);
      };
    },
    [id],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => storeFor(id).snapshot,
    () => SERVER_SNAPSHOT,
  );
  const { preferences, loaded, error } = snapshot;

  const setters = useMemo(() => {
    const set =
      <K extends keyof StoredTablePreferences>(key: K) =>
      (value: Updater<StoredTablePreferences[K]>) =>
        change(id, (previous) => ({
          ...previous,
          [key]: resolve(value, previous[key]),
        }));
    return {
      setSorting: set("sorting") as (value: Updater<SortingState>) => void,
      setVisibility: set("visibility") as (
        value: Updater<ColumnVisibilityState>,
      ) => void,
      setSizing: set("sizing") as (value: Updater<ColumnSizingState>) => void,
      setColumnOrder: set("column_order") as (
        value: Updater<string[] | undefined>,
      ) => void,
      setDensity: (value: StoredTablePreferences["density"]) =>
        change(id, (previous) => ({ ...previous, density: value })),
      /** Restores the columns, sort and row height; saved views stay. */
      reset: () =>
        change(id, (previous) => ({
          ...DEFAULT_PREFERENCES,
          views: previous.views,
          default_view: previous.default_view,
        })),
      setViews: (
        views: SavedTableView[],
        defaultView: string | null | undefined,
      ) =>
        change(id, (previous) => ({
          ...previous,
          views,
          default_view:
            defaultView && views.some((view) => view.id === defaultView)
              ? defaultView
              : null,
        })),
      /** Puts a view's sort, visible columns and column order on the table. */
      applyView: (view: SavedTableView) =>
        change(id, (previous) => ({
          ...previous,
          sorting: view.sorting,
          visibility: view.visibility,
          column_order: view.column_order,
        })),
      retry: () => {
        const store = storeFor(id);
        if (!store.snapshot.loaded) load(id);
        else if (store.dirty) save(id);
        else publish(store, { error: null });
      },
    };
  }, [id]);

  return {
    id,
    preferences,
    loaded,
    error: error ? translateBackendError(t, error) : null,
    views: preferences.views ?? [],
    defaultView: preferences.default_view ?? null,
    columnOrder: preferences.column_order ?? [],
    ...setters,
  };
}

export type TableView = ReturnType<typeof useTablePreferences>;
