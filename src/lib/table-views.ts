import type {
  ColumnVisibilityState,
  SortingState,
} from "@tanstack/react-table";
import type { TableFilterValues, TablePreferences } from "@/lib/table-tools";

/** Matches the Rust limit in `settings_manager.rs`. */
export const TABLE_VIEW_LIMIT = 32;
export const TABLE_VIEW_NAME_LIMIT = 80;

export interface SavedTableView {
  id: string;
  name: string;
  query: string;
  filters: TableFilterValues;
  sorting: SortingState;
  visibility: ColumnVisibilityState;
  column_order: string[];
}

/** What the backend stores; it leaves empty view fields out of the file. */
export interface StoredTablePreferences extends TablePreferences {
  column_order?: string[];
  views?: SavedTableView[];
  default_view?: string | null;
}

export interface TableViewState {
  query: string;
  filters: TableFilterValues;
  sorting: SortingState;
  visibility: ColumnVisibilityState;
  column_order: string[];
}

function cleanFilters(filters: TableFilterValues): TableFilterValues {
  return Object.fromEntries(
    Object.entries(filters)
      .filter(([, values]) => values.length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, values]) => [id, [...new Set(values)].sort()]),
  );
}

function cleanVisibility(
  visibility: ColumnVisibilityState,
): ColumnVisibilityState {
  return Object.fromEntries(
    Object.entries(visibility).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** A view of the current state, with its filters and columns in a stable order. */
export function captureTableView(
  id: string,
  name: string,
  state: TableViewState,
): SavedTableView {
  return {
    id,
    name: name.trim().slice(0, TABLE_VIEW_NAME_LIMIT),
    query: state.query.trim(),
    filters: cleanFilters(state.filters),
    sorting: state.sorting.map(({ id: column, desc }) => ({
      id: column,
      desc,
    })),
    visibility: cleanVisibility(state.visibility),
    column_order: [...state.column_order],
  };
}

/** Whether the table shows exactly what a view saved. */
export function tableViewMatches(
  view: SavedTableView,
  state: TableViewState,
): boolean {
  const current = captureTableView(view.id, view.name, state);
  const saved = captureTableView(view.id, view.name, view);
  return JSON.stringify(current) === JSON.stringify(saved);
}

/**
 * Adds a view, or replaces the view of the same name (case-insensitive).
 * Returns null when the list is full and the name is new.
 */
export function upsertTableView(
  views: SavedTableView[],
  view: SavedTableView,
): SavedTableView[] | null {
  const key = view.name.toLocaleLowerCase();
  const index = views.findIndex(
    (item) => item.name.toLocaleLowerCase() === key,
  );
  if (index >= 0)
    return views.map((item, i) =>
      i === index ? { ...view, id: item.id } : item,
    );
  if (views.length >= TABLE_VIEW_LIMIT) return null;
  return [...views, view];
}

export function findTableViewByName(
  views: SavedTableView[],
  name: string,
): SavedTableView | undefined {
  const key = name.trim().toLocaleLowerCase();
  return key
    ? views.find((view) => view.name.toLocaleLowerCase() === key)
    : undefined;
}

/** Keeps only filter values the table still offers. */
export function pruneTableViewFilters(
  filters: TableFilterValues,
  offered: { id: string; options: { value: string }[] }[],
): TableFilterValues {
  const result: TableFilterValues = {};
  for (const facet of offered) {
    const allowed = new Set(facet.options.map((option) => option.value));
    const values = (filters[facet.id] ?? []).filter((value) =>
      allowed.has(value),
    );
    if (values.length) result[facet.id] = values;
  }
  return result;
}

/**
 * The movable columns in display order: the saved order first, then any
 * column the saved order does not know, placed after its neighbour from the
 * column definitions.
 */
export function movableColumnOrder(
  movable: string[],
  saved: string[],
): string[] {
  const known = new Set(movable);
  const order = saved.filter((id, index) => {
    return known.has(id) && saved.indexOf(id) === index;
  });
  movable.forEach((id, index) => {
    if (order.includes(id)) return;
    const before = movable
      .slice(0, index)
      .reverse()
      .find((other) => order.includes(other));
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id);
  });
  return order;
}

/**
 * The full column order for the table: fixed columns (selection, actions)
 * stay where they are defined, and the movable columns fill their slots in
 * the saved order.
 */
export function orderTableColumns(
  all: string[],
  movable: string[],
  saved: string[],
): string[] {
  const present = movable.filter((id) => all.includes(id));
  const order = movableColumnOrder(present, saved);
  const slots = new Set(present);
  let next = 0;
  return all.map((id) => (slots.has(id) ? order[next++] : id));
}

/**
 * Moves one column a step left (-1) or right (1) past the next column the
 * person can see in the list. Returns the order unchanged at either end.
 */
export function moveTableColumn(
  order: string[],
  id: string,
  delta: -1 | 1,
  listed: Set<string>,
): string[] {
  const index = order.indexOf(id);
  if (index < 0) return order;
  let neighbour = index + delta;
  while (neighbour >= 0 && neighbour < order.length) {
    if (listed.has(order[neighbour])) break;
    neighbour += delta;
  }
  if (neighbour < 0 || neighbour >= order.length) return order;
  const target = order[neighbour];
  const rest = order.filter((item) => item !== id);
  const at = rest.indexOf(target) + (delta > 0 ? 1 : 0);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
