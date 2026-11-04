import type {
  ColumnSizingState,
  ColumnVisibilityState,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";

export type TableId =
  | "profiles"
  | "proxies"
  | "vpns"
  | "extensions"
  | "extensionGroups"
  | "groups"
  | "trash";
export interface TablePreferences {
  visibility: ColumnVisibilityState;
  sizing: ColumnSizingState;
  sorting: SortingState;
  density: "compact" | "comfortable";
}

export interface TableFilter<T> {
  id: string;
  label: string;
  value: (row: T) => string | string[];
  options: { value: string; label: string }[];
}
export type TableFilterValues = Record<string, string[]>;

export function filterTableRows<T>(
  rows: T[],
  query: string,
  searchText: (row: T) => string,
  filters: TableFilter<T>[],
  values: TableFilterValues,
  except?: string,
): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(
    (row) =>
      terms.every((term) =>
        searchText(row).toLocaleLowerCase().includes(term),
      ) &&
      filters.every((filter) => {
        const selected = values[filter.id];
        if (filter.id === except || !selected?.length) return true;
        const raw = filter.value(row);
        const rowValues = Array.isArray(raw) ? raw : [raw];
        return selected.some((value) => rowValues.includes(value));
      }),
  );
}

export function selectTableRange(
  orderedIds: string[],
  selection: RowSelectionState,
  anchor: string | null,
  target: string,
  checked: boolean,
  extend: boolean,
): RowSelectionState {
  const end = orderedIds.indexOf(target);
  if (end === -1) return selection;
  const start = extend && anchor ? orderedIds.indexOf(anchor) : -1;
  const targets =
    start === -1
      ? [target]
      : orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1);
  const next = { ...selection };
  for (const id of targets) {
    if (checked) next[id] = true;
    else delete next[id];
  }
  return next;
}

export function resolveTableVisibility(
  automatic: ColumnVisibilityState,
  choices: ColumnVisibilityState,
  required: string[] = [],
  unavailable: string[] = [],
): ColumnVisibilityState {
  const result = { ...automatic, ...choices };
  for (const id of required) result[id] = true;
  for (const id of unavailable) result[id] = false;
  return result;
}

/** Pinned rows first, each part in the order it came. */
export function pinnedFirst<T extends { id: string }>(
  rows: readonly T[],
  pinned: ReadonlySet<string>,
): T[] {
  if (pinned.size === 0) return [...rows];
  return [
    ...rows.filter((row) => pinned.has(row.id)),
    ...rows.filter((row) => !pinned.has(row.id)),
  ];
}

/** Pins `ids`, or unpins them when every one is pinned already. */
export function togglePins(
  pinned: readonly string[],
  ids: readonly string[],
): string[] {
  const set = new Set(pinned);
  if (ids.every((id) => set.has(id))) {
    return pinned.filter((id) => !ids.includes(id));
  }
  return [...pinned, ...ids.filter((id) => !set.has(id))];
}
