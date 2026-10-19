"use client";

import type { RowData } from "@tanstack/react-table";
import type { LegacyTable as Table } from "@tanstack/react-table/legacy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  filterTableRows,
  type TableFilter,
  type TableFilterValues,
  type TableId,
} from "@/lib/table-tools";

/**
 * Search and facet filters for one table. The selection is left alone: rows a
 * filter hides stay selected, and the selection bar counts them.
 */
export function useTableFilters<T>(
  data: T[],
  searchText: (row: T) => string,
  definitions: TableFilter<T>[],
  tableId?: TableId,
) {
  const [query, setQuery] = useState("");
  const [values, setValues] = useState<TableFilterValues>({});
  const rows = useMemo(
    () => filterTableRows(data, query, searchText, definitions, values),
    [data, query, searchText, definitions, values],
  );
  const facets = useMemo(
    () =>
      definitions.map((filter) => {
        const candidates = filterTableRows(
          data,
          query,
          searchText,
          definitions,
          values,
          filter.id,
        );
        const counts = new Map<string, number>();
        for (const row of candidates) {
          const raw = filter.value(row);
          for (const value of new Set(Array.isArray(raw) ? raw : [raw]))
            counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        return {
          id: filter.id,
          label: filter.label,
          options: filter.options.map((option) => ({
            ...option,
            count: counts.get(option.value) ?? 0,
          })),
        };
      }),
    [data, query, searchText, definitions, values],
  );
  return {
    tableId,
    query,
    values,
    rows,
    facets,
    total: data.length,
    onQueryChange: setQuery,
    onValuesChange: setValues,
    reset: () => {
      setQuery("");
      setValues({});
    },
  };
}

const TABBABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

/**
 * The next element Tab reaches outside `boundary`, after it (forward) or
 * before it (backward), inside the dialog that holds it when there is one.
 */
function tabbableOutside(boundary: HTMLElement, forward: boolean) {
  const scope =
    boundary.closest<HTMLElement>('[role="dialog"],[role="alertdialog"]') ??
    document.body;
  const candidates = [...scope.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !boundary.contains(element) &&
      !element.closest("[inert]") &&
      element.getClientRects().length > 0,
  );
  const side = forward
    ? Node.DOCUMENT_POSITION_FOLLOWING
    : Node.DOCUMENT_POSITION_PRECEDING;
  const outside = candidates.filter(
    (element) =>
      boundary.compareDocumentPosition(element) & side &&
      !(element.contains(boundary) || boundary.contains(element)),
  );
  return forward ? outside[0] : outside.at(-1);
}

export function useTableKeyboard<T extends RowData>(
  table: Table<T>,
  options?: {
    scrollToIndex?: (index: number) => void;
    edit?: (rowId: string, columnId: string) => boolean;
  },
) {
  const element = useRef<HTMLTableElement | null>(null);
  const [active, setActive] = useState<{
    rowId: string;
    columnId: string;
  } | null>(null);
  const pending = useRef<number | null>(null);
  const lastTab = useRef(0);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") lastTab.current = performance.now();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (pending.current !== null) cancelAnimationFrame(pending.current);
    };
  }, []);
  const rows = table.getRowModel().rows;
  const columns = table.getVisibleLeafColumns();
  const rowId = rows.some((row) => row.id === active?.rowId)
    ? active?.rowId
    : rows[0]?.id;
  const columnId = columns.some((column) => column.id === active?.columnId)
    ? active?.columnId
    : (columns.find((column) => column.id === "name")?.id ?? columns[0]?.id);

  const focusCell = useCallback((nextRow: string, nextColumn: string) => {
    setActive({ rowId: nextRow, columnId: nextColumn });
    if (pending.current !== null) cancelAnimationFrame(pending.current);
    let attempts = 0;
    const focus = () => {
      const cell = element.current?.querySelector<HTMLElement>(
        `[data-table-row="${CSS.escape(nextRow)}"] [data-table-column="${CSS.escape(nextColumn)}"]`,
      );
      if (cell) {
        cell.focus({ preventScroll: true });
        cell.scrollIntoView({ block: "nearest", inline: "nearest" });
        pending.current = null;
      } else if (++attempts < 8) pending.current = requestAnimationFrame(focus);
    };
    pending.current = requestAnimationFrame(focus);
  }, []);

  // Tab into the rows lands on the remembered cell, not on the first button
  // of the first row: the rows are one stop, and arrows move inside them.
  const enter = useRef<(event: FocusEvent) => void>(() => {});
  enter.current = (event) => {
    const target = event.target as HTMLElement;
    const body = target.closest("tbody");
    if (
      !body ||
      !rowId ||
      !columnId ||
      performance.now() - lastTab.current > 200 ||
      body.contains(event.relatedTarget as Node | null) ||
      (target.dataset.tableColumn === columnId &&
        target.closest<HTMLElement>("[data-table-row]")?.dataset.tableRow ===
          rowId)
    )
      return;
    options?.scrollToIndex?.(rows.findIndex((row) => row.id === rowId));
    focusCell(rowId, columnId);
  };
  const tableRef = useCallback((node: HTMLTableElement | null) => {
    element.current = node;
    if (!node) return;
    const onFocusIn = (event: FocusEvent) => enter.current(event);
    node.addEventListener("focusin", onFocusIn);
    return () => node.removeEventListener("focusin", onFocusIn);
  }, []);

  return {
    tableRef,
    cellProps: (currentRow: string, currentColumn: string) => ({
      "data-table-column": currentColumn,
      tabIndex: currentRow === rowId && currentColumn === columnId ? 0 : -1,
      onFocus: () =>
        setActive((prev) =>
          prev?.rowId === currentRow && prev.columnId === currentColumn
            ? prev
            : { rowId: currentRow, columnId: currentColumn },
        ),
    }),
    onKeyDown: (event: React.KeyboardEvent<HTMLTableElement>) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey
      )
        return;
      const target = event.target as HTMLElement;
      if (event.key === "Tab") {
        // Tab leaves the rows for the next control on the page; Shift+Tab
        // goes back to the header. Arrow keys move between cells.
        const body = target.closest("tbody");
        if (
          !body ||
          !element.current?.contains(body) ||
          target.matches('input,textarea,[contenteditable="true"]')
        )
          return;
        const next = tabbableOutside(body, !event.shiftKey);
        if (!next) return;
        event.preventDefault();
        next.focus();
        return;
      }
      const cell = target.closest<HTMLElement>("[data-table-column]");
      if (!cell || !element.current?.contains(cell)) return;
      if (target !== cell) return;
      const currentRow =
        cell.closest<HTMLElement>("[data-table-row]")?.dataset.tableRow;
      const currentColumn = cell.dataset.tableColumn;
      let r = rows.findIndex((row) => row.id === currentRow);
      let c = columns.findIndex((column) => column.id === currentColumn);
      if (r < 0 || c < 0) return;
      if (event.key === "Enter" || event.key === "F2") {
        event.preventDefault();
        if (
          !(
            currentRow &&
            currentColumn &&
            options?.edit?.(currentRow, currentColumn)
          )
        ) {
          const control = cell.querySelector<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [role="combobox"]',
          );
          control?.focus();
          if (
            event.key === "Enter" ||
            ["name", "tags", "note"].includes(currentColumn ?? "")
          )
            control?.click();
        }
        return;
      }
      if (event.key === "ArrowDown") r++;
      else if (event.key === "ArrowUp") r--;
      else if (event.key === "ArrowRight") c++;
      else if (event.key === "ArrowLeft") c--;
      else if (event.key === "Home") c = 0;
      else if (event.key === "End") c = columns.length - 1;
      else return;
      event.preventDefault();
      r = Math.max(0, Math.min(rows.length - 1, r));
      c = Math.max(0, Math.min(columns.length - 1, c));
      options?.scrollToIndex?.(r);
      focusCell(rows[r].id, columns[c].id);
    },
    onKeyDownCapture: (event: React.KeyboardEvent<HTMLTableElement>) => {
      if (event.key !== "Escape" || !rowId || !columnId) return;
      const target = event.target as HTMLElement;
      if (target.matches('input,textarea,[contenteditable="true"]'))
        focusCell(rowId, columnId);
    },
  };
}
