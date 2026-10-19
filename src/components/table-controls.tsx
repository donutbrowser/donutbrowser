"use client";

import type { RowData } from "@tanstack/react-table";
import type {
  LegacyColumn as Column,
  LegacyHeader as Header,
  LegacyRow as Row,
  LegacyTable as Table,
} from "@tanstack/react-table/legacy";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  LuArrowDown,
  LuArrowLeft,
  LuArrowRight,
  LuArrowUp,
  LuArrowUpDown,
  LuBookmark,
  LuCheck,
  LuChevronsUp,
  LuListFilter,
  LuPencil,
  LuPlus,
  LuSearch,
  LuSettings2,
  LuStar,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import {
  type TableView,
  useTablePreferences,
} from "@/hooks/use-table-preferences";
import { MOTION_DURATION, MOTION_EASE_OUT, MOTION_SPRING } from "@/lib/motion";
import {
  selectTableRange,
  type TableFilterValues,
  type TableId,
} from "@/lib/table-tools";
import {
  captureTableView,
  findTableViewByName,
  movableColumnOrder,
  moveTableColumn,
  orderTableColumns,
  pruneTableViewFilters,
  type SavedTableView,
  TABLE_VIEW_LIMIT,
  TABLE_VIEW_NAME_LIMIT,
  type TableViewState,
  tableViewMatches,
  upsertTableView,
} from "@/lib/table-views";
import { showErrorToast, showUndoToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";

/**
 * Class names shared by the profile table and the management tables. The
 * shapes and tints live in `.data-table` (globals.css); these strip the base
 * table primitives' borders and row fills so they cannot paint under them.
 */
export const DATA_TABLE_CLASSES = {
  table: "data-table table-fixed",
  header: "sticky top-0 z-10 bg-background [&_tr]:border-0",
  headerRow: "border-0 hover:bg-transparent",
  head: "relative text-xs font-medium text-muted-foreground",
  row: "border-0 hover:bg-transparent data-[state=selected]:bg-transparent",
  cell: "py-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
} as const;

export interface TableColumnLabel {
  id: string;
  label: string;
  hideable?: boolean;
}
export interface FilterFacet {
  id: string;
  label: string;
  options: { value: string; label: string; count: number }[];
}

export function TableFilterControls({
  query,
  onQueryChange,
  values,
  onValuesChange,
  facets,
  count,
  total,
  onReset,
  showSearch = true,
  tableId,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  values: TableFilterValues;
  onValuesChange: (values: TableFilterValues) => void;
  facets: FilterFacet[];
  count: number;
  total: number;
  onReset: () => void;
  showSearch?: boolean;
  /** Offers the table's saved views next to the filters. */
  tableId?: TableId;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const active =
    Object.values(values).some((items) => items.length > 0) || query.length > 0;
  return (
    <div
      data-slot="table-filters"
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      {tableId && (
        <SavedViewsMenu
          tableId={tableId}
          query={query}
          values={values}
          facets={facets}
          onApply={(nextQuery, nextValues) => {
            onQueryChange(nextQuery);
            onValuesChange(nextValues);
          }}
        />
      )}
      {showSearch && (
        <div className="relative">
          <LuSearch className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            variant="soft"
            aria-label={t("tables.search")}
            placeholder={t("tables.search")}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            className="h-8 w-48 pl-8 text-xs md:text-xs"
          />
        </div>
      )}
      {facets.length > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="soft"
              size="sm"
              className="h-8 gap-1.5 rounded-lg px-2.5 text-xs"
            >
              <LuListFilter className="size-3.5" />
              {t("tables.filters")}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-0">
            <Command>
              <CommandInput placeholder={t("tables.findFilter")} />
              <CommandList>
                <CommandEmpty>{t("tables.noOptions")}</CommandEmpty>
                {facets.map((facet) => (
                  <CommandGroup key={facet.id} heading={facet.label}>
                    {facet.options.map((option) => {
                      const selected =
                        values[facet.id]?.includes(option.value) ?? false;
                      return (
                        <CommandItem
                          key={option.value}
                          value={`${facet.label} ${option.label}`}
                          aria-checked={selected}
                          onSelect={() =>
                            onValuesChange({
                              ...values,
                              [facet.id]: selected
                                ? values[facet.id].filter(
                                    (value) => value !== option.value,
                                  )
                                : [...(values[facet.id] ?? []), option.value],
                            })
                          }
                        >
                          <span
                            className={cn(
                              "grid size-4 place-items-center rounded-[4px] border border-foreground/25 transition-colors duration-100",
                              selected &&
                                "border-primary bg-primary text-primary-foreground",
                            )}
                          >
                            {selected && <LuCheck className="size-3" />}
                          </span>
                          <span className="flex-1 truncate">
                            {option.label}
                          </span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {option.count}
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
      {facets.flatMap((facet) =>
        (values[facet.id] ?? []).map((value) => {
          const label =
            facet.options.find((option) => option.value === value)?.label ??
            value;
          return (
            <Button
              key={`${facet.id}:${value}`}
              variant="soft"
              size="sm"
              className="h-7 max-w-64 gap-1 rounded-full bg-primary/10 pr-2 pl-2.5 text-xs hover:bg-primary/12"
              aria-label={t("tables.removeFilter", {
                filter: `${facet.label}: ${label}`,
              })}
              onClick={() =>
                onValuesChange({
                  ...values,
                  [facet.id]: values[facet.id].filter((item) => item !== value),
                })
              }
            >
              <span className="truncate">
                <span className="text-muted-foreground">{facet.label}:</span>{" "}
                {label}
              </span>
              <LuX className="size-3 shrink-0 opacity-60" />
            </Button>
          );
        }),
      )}
      {active && (
        <Button
          variant="subtle"
          size="sm"
          className="h-7 rounded-lg px-2 text-xs"
          onClick={onReset}
        >
          {t("tables.clearFilters")}
        </Button>
      )}
      <span
        data-slot="table-result-count"
        role="status"
        className="px-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
      >
        {t("tables.results", { count, total })}
      </span>
    </div>
  );
}

/** Tables whose default view this session has already applied. */
const startViewsApplied = new Set<TableId>();

function newViewId() {
  return crypto.randomUUID();
}

/**
 * Named views of a table: the search, filters, sort, visible columns and
 * column order, saved under a name. One view can open at start.
 */
function SavedViewsMenu({
  tableId,
  query,
  values,
  facets,
  onApply,
}: {
  tableId: TableId;
  query: string;
  values: TableFilterValues;
  facets: FilterFacet[];
  onApply: (query: string, values: TableFilterValues) => void;
}) {
  const { t } = useTranslation();
  const view = useTablePreferences(tableId);
  const motionAllowed = useMotionAllowed();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const { views, defaultView } = view;
  const state: TableViewState = {
    query,
    filters: values,
    sorting: view.preferences.sorting,
    visibility: view.preferences.visibility,
    column_order: view.columnOrder,
  };
  const current = views.find((item) => tableViewMatches(item, state));
  const replacing = findTableViewByName(views, name);
  const draftTaken =
    renaming !== null &&
    views.some(
      (item) =>
        item.id !== renaming &&
        item.name.toLocaleLowerCase() === draft.trim().toLocaleLowerCase(),
    );

  const apply = (saved: SavedTableView, offered?: FilterFacet[]) => {
    view.applyView(saved);
    onApply(
      saved.query,
      offered ? pruneTableViewFilters(saved.filters, offered) : saved.filters,
    );
  };

  // The default view opens once per app start, before any other choice.
  useEffect(() => {
    if (!view.loaded || startViewsApplied.has(tableId)) return;
    startViewsApplied.add(tableId);
    const saved = views.find((item) => item.id === defaultView);
    if (saved) apply(saved);
  });

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = upsertTableView(
      views,
      captureTableView(replacing?.id ?? newViewId(), trimmed, state),
    );
    if (!next) {
      showErrorToast(t("tables.views.full", { limit: TABLE_VIEW_LIMIT }));
      return;
    }
    view.setViews(next, defaultView);
    setName("");
  };

  const commitRename = () => {
    const trimmed = draft.trim();
    if (renaming && trimmed && !draftTaken)
      view.setViews(
        views.map((item) =>
          item.id === renaming ? { ...item, name: trimmed } : item,
        ),
        defaultView,
      );
    setRenaming(null);
  };

  const remove = (saved: SavedTableView) => {
    const previous = { views, defaultView };
    view.setViews(
      views.filter((item) => item.id !== saved.id),
      defaultView === saved.id ? null : defaultView,
    );
    showUndoToast(t("tables.views.deleted", { name: saved.name }), () =>
      view.setViews(previous.views, previous.defaultView),
    );
  };

  const swap = motionAllowed
    ? {
        initial: { opacity: 0.5, y: 4 },
        exit: {
          opacity: 0,
          y: -4,
          transition: { duration: MOTION_DURATION.fast },
        },
      }
    : {
        initial: false as const,
        exit: { opacity: 0, transition: { duration: 0 } },
      };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setRenaming(null);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="soft"
          size="sm"
          data-slot="table-views-trigger"
          className="h-8 max-w-56 gap-1.5 overflow-hidden rounded-lg px-2.5 text-xs"
          disabled={!view.loaded}
        >
          <LuBookmark className="size-3.5 shrink-0" />
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={current?.id ?? ""}
              className="truncate"
              initial={swap.initial}
              animate={{ opacity: 1, y: 0 }}
              exit={swap.exit}
              transition={{
                duration: MOTION_DURATION.base,
                ease: MOTION_EASE_OUT,
              }}
            >
              {current?.name ?? t("tables.views.label")}
            </motion.span>
          </AnimatePresence>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="p-1.5">
          <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
            {t("tables.views.title")}
          </p>
          {views.length === 0 ? (
            <p className="px-2 pb-2 text-xs text-pretty text-muted-foreground">
              {t("tables.views.empty")}
            </p>
          ) : (
            <ul
              data-slot="table-views-list"
              className="-mx-1 max-h-64 space-y-0.5 overflow-y-auto p-1"
            >
              <AnimatePresence initial={false} mode="popLayout">
                {views.map((saved) => {
                  const isCurrent = saved.id === current?.id;
                  const isDefault = saved.id === defaultView;
                  return (
                    <motion.li
                      key={saved.id}
                      data-view-id={saved.id}
                      layout={motionAllowed ? "position" : false}
                      initial={motionAllowed ? { opacity: 0.5, y: -4 } : false}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{
                        opacity: 0,
                        transition: {
                          duration: motionAllowed ? MOTION_DURATION.fast : 0,
                        },
                      }}
                      transition={{
                        duration: MOTION_DURATION.base,
                        ease: MOTION_EASE_OUT,
                        layout: MOTION_SPRING.position,
                      }}
                      className="flex min-h-8 items-center gap-0.5 rounded-md transition-colors duration-100 hover:bg-foreground/5"
                    >
                      {renaming === saved.id ? (
                        <Input
                          variant="soft"
                          autoFocus
                          aria-label={t("tables.views.nameLabel")}
                          aria-invalid={draftTaken || undefined}
                          title={
                            draftTaken ? t("tables.views.nameTaken") : undefined
                          }
                          maxLength={TABLE_VIEW_NAME_LIMIT}
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitRename();
                            }
                          }}
                          className="h-7 min-w-0 flex-1 text-xs md:text-xs"
                        />
                      ) : (
                        <button
                          type="button"
                          aria-current={isCurrent || undefined}
                          onClick={() => {
                            apply(saved, facets);
                            setOpen(false);
                          }}
                          className={cn(
                            "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm",
                            FOCUS_RING,
                          )}
                        >
                          <LuCheck
                            aria-hidden="true"
                            className={cn(
                              "size-3.5 shrink-0 transition-opacity duration-100",
                              isCurrent ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <span className="truncate">{saved.name}</span>
                          {isDefault && (
                            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-[11px] leading-4 text-muted-foreground">
                              {t("tables.views.defaultBadge")}
                            </span>
                          )}
                        </button>
                      )}
                      <Button
                        size="icon"
                        variant="subtle"
                        className="size-7 shrink-0 rounded-md"
                        aria-pressed={isDefault}
                        aria-label={t("tables.views.useAtStart", {
                          name: saved.name,
                        })}
                        title={t("tables.views.useAtStart", {
                          name: saved.name,
                        })}
                        onClick={() =>
                          view.setViews(views, isDefault ? null : saved.id)
                        }
                      >
                        <LuStar
                          className={cn(
                            "size-3.5",
                            isDefault && "fill-current text-foreground",
                          )}
                        />
                      </Button>
                      <Button
                        size="icon"
                        variant="subtle"
                        className="size-7 shrink-0 rounded-md"
                        aria-label={t("tables.views.rename", {
                          name: saved.name,
                        })}
                        title={t("tables.views.rename", { name: saved.name })}
                        onClick={() => {
                          setDraft(saved.name);
                          setRenaming(saved.id);
                        }}
                      >
                        <LuPencil className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="subtle"
                        className="size-7 shrink-0 rounded-md hover:bg-destructive/10 hover:text-destructive-text"
                        aria-label={t("tables.views.delete", {
                          name: saved.name,
                        })}
                        title={t("tables.views.delete", { name: saved.name })}
                        onClick={() => remove(saved)}
                      >
                        <LuTrash2 className="size-3.5" />
                      </Button>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          )}
        </div>
        <form
          className="flex items-center gap-1.5 border-t border-border p-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Input
            variant="soft"
            aria-label={t("tables.views.nameLabel")}
            placeholder={t("tables.views.namePlaceholder")}
            maxLength={TABLE_VIEW_NAME_LIMIT}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-8 min-w-0 flex-1 text-xs md:text-xs"
          />
          <Button
            type="submit"
            size="sm"
            variant="soft"
            data-slot="table-views-save"
            className="h-8 rounded-lg text-xs"
            disabled={!name.trim()}
          >
            {replacing ? t("tables.views.replace") : t("common.buttons.save")}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function TableViewControls<T extends RowData>({
  table,
  view,
  labels,
}: {
  table: Table<T>;
  view: TableView;
  labels: TableColumnLabel[];
}) {
  const { t } = useTranslation();
  const motionAllowed = useMotionAllowed();
  const sorting = table.options.state?.sorting ?? [];
  const sortColumns = labels.filter(({ id }) =>
    table.getColumn(id)?.getCanSort(),
  );
  const columnIds = table.getAllLeafColumns().map((column) => column.id);
  const movable = labels
    .map((label) => label.id)
    .filter((id) => columnIds.includes(id));
  const order = movableColumnOrder(movable, view.columnOrder);
  // The columns the list offers: every one a person can show or hide, and
  // the fixed ones on screen.
  const listed = order
    .map((id) => labels.find((label) => label.id === id))
    .filter(
      (label): label is TableColumnLabel =>
        !!label &&
        (label.hideable !== false ||
          (table.getColumn(label.id)?.getIsVisible() ?? false)),
    );
  const listedIds = new Set(listed.map((label) => label.id));
  const fullOrder = orderTableColumns(
    columnIds,
    movable,
    view.columnOrder,
  ).join("\n");
  // The saved order reaches the table here, so every table that shows these
  // controls follows it.
  useLayoutEffect(() => {
    const current = (table.atoms.columnOrder?.get() ?? []).join("\n");
    if (current !== fullOrder) table.setColumnOrder(fullOrder.split("\n"));
  }, [table, fullOrder]);
  const move = (id: string, delta: -1 | 1) =>
    view.setColumnOrder(moveTableColumn(order, id, delta, listedIds));
  const name = (id: string) =>
    labels.find((column) => column.id === id)?.label ?? id;
  const primarySort = sorting[0];
  const direction = (desc: boolean) =>
    t(desc ? "tables.descending" : "tables.ascending");
  return (
    <div
      data-slot="table-view-controls"
      className="flex flex-wrap items-center gap-1.5"
    >
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="soft"
            size="sm"
            data-slot="table-sort-trigger"
            className="h-8 max-w-72 gap-1.5 rounded-lg px-2.5 text-xs"
            disabled={!view.loaded}
            title={
              primarySort
                ? t("tables.sortSummary", {
                    column: name(primarySort.id),
                    direction: direction(primarySort.desc),
                  })
                : undefined
            }
          >
            <LuArrowUpDown className="size-3.5 shrink-0" />
            <span className="truncate">
              {primarySort ? name(primarySort.id) : t("tables.sort")}
            </span>
            {primarySort && (
              <>
                {primarySort.desc ? (
                  <LuArrowDown
                    aria-hidden="true"
                    className="size-3 shrink-0 text-muted-foreground"
                  />
                ) : (
                  <LuArrowUp
                    aria-hidden="true"
                    className="size-3 shrink-0 text-muted-foreground"
                  />
                )}
                <span className="sr-only">{direction(primarySort.desc)}</span>
              </>
            )}
            {sorting.length > 1 && (
              <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] leading-4 tabular-nums">
                +{sorting.length - 1}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 space-y-2 p-3">
          <p className="px-1 text-xs font-medium text-muted-foreground">
            {t("tables.sort")}
          </p>
          {sorting.map((sort, index) => (
            <div
              key={sort.id}
              data-sort-index={index}
              className="flex items-center gap-1"
            >
              <span className="w-4 text-center text-xs text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <Select
                value={sort.id}
                onValueChange={(id) =>
                  table.setSorting(
                    sorting.map((item, i) =>
                      i === index ? { ...item, id } : item,
                    ),
                  )
                }
              >
                <SelectTrigger
                  variant="soft"
                  aria-label={t("tables.sortColumn")}
                  className="h-8 min-w-0 flex-1 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sortColumns
                    .filter(
                      (column) =>
                        column.id === sort.id ||
                        !sorting.some((item) => item.id === column.id),
                    )
                    .map((column) => (
                      <SelectItem key={column.id} value={column.id}>
                        {column.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Button
                size="icon"
                variant="soft"
                className="size-8 rounded-lg"
                aria-label={direction(sort.desc)}
                onClick={() =>
                  table.setSorting(
                    sorting.map((item, i) =>
                      i === index ? { ...item, desc: !item.desc } : item,
                    ),
                  )
                }
              >
                {sort.desc ? <LuArrowDown /> : <LuArrowUp />}
              </Button>
              <Button
                size="icon"
                variant="subtle"
                className="size-8 rounded-lg"
                disabled={index === 0}
                aria-label={t("tables.moveSortUp")}
                onClick={() => {
                  const next = [...sorting];
                  [next[index - 1], next[index]] = [
                    next[index],
                    next[index - 1],
                  ];
                  table.setSorting(next);
                }}
              >
                <LuChevronsUp />
              </Button>
              <Button
                size="icon"
                variant="subtle"
                className="size-8 rounded-lg"
                aria-label={t("tables.removeSort")}
                onClick={() =>
                  table.setSorting(sorting.filter((_, i) => i !== index))
                }
              >
                <LuX />
              </Button>
            </div>
          ))}
          <div className="flex gap-1 pt-1">
            <Button
              size="sm"
              variant="soft"
              className="h-8 rounded-lg text-xs"
              disabled={sortColumns.every((column) =>
                sorting.some((sort) => sort.id === column.id),
              )}
              onClick={() => {
                const column = sortColumns.find(
                  (item) => !sorting.some((sort) => sort.id === item.id),
                );
                if (column)
                  table.setSorting([
                    ...sorting,
                    { id: column.id, desc: false },
                  ]);
              }}
            >
              <LuPlus />
              {t("tables.addSort")}
            </Button>
            <Button
              variant="subtle"
              size="sm"
              className="h-8 rounded-lg text-xs"
              onClick={() => table.setSorting([])}
            >
              {t("tables.clearSort")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            data-slot="table-view-trigger"
            variant="soft"
            size="sm"
            className="h-8 gap-1.5 rounded-lg px-2.5 text-xs"
            disabled={!view.loaded}
          >
            <LuSettings2 className="size-3.5" />
            {t("tables.view")}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 space-y-3 p-3">
          <div className="space-y-1">
            <p className="px-1 text-xs font-medium text-muted-foreground">
              {t("tables.columns")}
            </p>
            <div className="max-h-64 space-y-0.5 overflow-y-auto">
              {listed.map((label, index) => (
                <motion.div
                  key={label.id}
                  data-column-id={label.id}
                  layout={motionAllowed ? "position" : false}
                  transition={MOTION_SPRING.position}
                  className="flex min-h-8 items-center gap-0.5 rounded-md pr-0.5 transition-colors duration-100 hover:bg-foreground/6"
                >
                  <label
                    htmlFor={`table-visible-${view.id}-${label.id}`}
                    className={cn(
                      "flex min-h-8 min-w-0 flex-1 items-center gap-2 px-1.5",
                      label.hideable !== false && "cursor-pointer",
                    )}
                  >
                    <Checkbox
                      id={`table-visible-${view.id}-${label.id}`}
                      checked={
                        table.getColumn(label.id)?.getIsVisible() ?? false
                      }
                      disabled={label.hideable === false}
                      onCheckedChange={(checked) =>
                        view.setVisibility((prev) => ({
                          ...prev,
                          [label.id]: !!checked,
                        }))
                      }
                    />
                    <span className="truncate text-sm">{label.label}</span>
                  </label>
                  {(
                    [
                      [-1, "tables.moveColumnLeft", LuArrowLeft],
                      [1, "tables.moveColumnRight", LuArrowRight],
                    ] as const
                  ).map(([delta, key, Icon]) => {
                    const end =
                      delta < 0 ? index === 0 : index === listed.length - 1;
                    return (
                      <Button
                        key={key}
                        size="icon"
                        variant="subtle"
                        className="size-6 shrink-0 rounded-md aria-disabled:pointer-events-none aria-disabled:opacity-35"
                        aria-label={t(key, { column: label.label })}
                        title={t(key, { column: label.label })}
                        aria-disabled={end || !view.loaded || undefined}
                        onClick={() => {
                          if (!end) move(label.id, delta);
                        }}
                      >
                        <Icon className="size-3.5" />
                      </Button>
                    );
                  })}
                </motion.div>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <p className="px-1 text-xs font-medium text-muted-foreground">
              {t("tables.rowHeight")}
            </p>
            <Select
              value={view.preferences.density}
              onValueChange={(value: "compact" | "comfortable") =>
                view.setDensity(value)
              }
            >
              <SelectTrigger
                variant="soft"
                aria-label={t("tables.rowHeight")}
                className="h-8 w-full text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="compact">{t("tables.compact")}</SelectItem>
                <SelectItem value="comfortable">
                  {t("tables.comfortable")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="subtle"
            size="sm"
            className="h-8 w-full rounded-lg text-xs"
            onClick={view.reset}
          >
            {t("tables.resetView")}
          </Button>
        </PopoverContent>
      </Popover>
      {view.error && (
        <span
          role="alert"
          className="flex items-center gap-1 text-xs text-destructive-text"
        >
          {view.error}
          <Button
            variant="subtle"
            size="sm"
            className="h-7 rounded-lg text-xs"
            onClick={view.retry}
          >
            {t("common.buttons.retry")}
          </Button>
        </span>
      )}
    </div>
  );
}

/** A column header that sorts its column, shaped like the other headers. */
export function SortableColumnHeader<T extends RowData>({
  column,
  label,
}: {
  column: Column<T, unknown>;
  label: string;
}) {
  const sorted = column.getIsSorted();
  return (
    <Button
      variant="subtle"
      onClick={() => column.toggleSorting(sorted === "asc")}
      className="-ml-1.5 h-6 justify-start gap-1 rounded-md px-1.5 text-left text-xs font-medium"
    >
      {label}
      {sorted === "asc" ? (
        <LuArrowUp className="size-3" />
      ) : sorted === "desc" ? (
        <LuArrowDown className="size-3" />
      ) : (
        <LuArrowUpDown className="size-3 opacity-60" />
      )}
    </Button>
  );
}

const selectionAnchors = new WeakMap<object, string>();

/** Centers a selection checkbox in its cell, at any column width. Inline, it
 * would sit on the text baseline and hug the cell's start. */
export function TableCheckboxSlot({ children }: { children: React.ReactNode }) {
  return <span className="flex items-center justify-center">{children}</span>;
}

/** A selection column at least this wide shows each row's icon beside its checkbox. */
const SELECT_WITH_ICON_WIDTH = 48;

function selectColumnHoldsIcons<T extends RowData>(table: Table<T>) {
  return (table.getColumn("select")?.getSize() ?? 0) >= SELECT_WITH_ICON_WIDTH;
}

/**
 * Selects or clears every row on screen. Rows a filter hides keep their
 * state, so a selection survives a search.
 */
export function TableSelectHeader<T extends RowData>({
  table,
}: {
  table: Table<T>;
}) {
  const { t } = useTranslation();
  const selectable = table
    .getRowModel()
    .rows.filter((row) => row.getCanSelect());
  const selected = selectable.filter((row) => row.getIsSelected()).length;
  return (
    <TableCheckboxSlot>
      <span data-slot="table-selection" className="flex items-center gap-1.5">
        <Checkbox
          aria-label={t("common.aria.selectAll")}
          className="relative after:absolute after:-inset-2 after:content-['']"
          checked={
            selected > 0 && selected === selectable.length
              ? true
              : selected > 0
                ? "indeterminate"
                : false
          }
          disabled={!selectable.length}
          onCheckedChange={(checked) => {
            selectionAnchors.delete(table);
            table.setRowSelection((prev) => {
              const next = { ...prev };
              for (const row of selectable) {
                if (checked) next[row.id] = true;
                else delete next[row.id];
              }
              return next;
            });
          }}
        />
        {selectColumnHoldsIcons(table) && (
          <span aria-hidden="true" className="size-4 shrink-0" />
        )}
      </span>
    </TableCheckboxSlot>
  );
}

export function TableRowCheckbox<T extends RowData>({
  table,
  row,
  icon,
}: {
  table: Table<T>;
  row: Row<T>;
  icon?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const name = (row.original as { name?: unknown }).name;
  return (
    <TableCheckboxSlot>
      <span data-slot="table-selection" className="flex items-center gap-1.5">
        <Checkbox
          aria-label={
            typeof name === "string" && name
              ? t("tables.selectRowNamed", { name })
              : t("common.aria.selectRow")
          }
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          className="relative after:absolute after:-inset-2 after:content-['']"
          onClick={(event) => {
            if (!row.getCanSelect()) return;
            const ids = table
              .getRowModel()
              .rows.filter((item) => item.getCanSelect())
              .map((item) => item.id);
            table.setRowSelection((prev) =>
              selectTableRange(
                ids,
                prev,
                selectionAnchors.get(table) ?? null,
                row.id,
                !row.getIsSelected(),
                event.shiftKey,
              ),
            );
            if (!event.shiftKey) selectionAnchors.set(table, row.id);
          }}
        />
        {icon && selectColumnHoldsIcons(table) && (
          <span
            aria-hidden="true"
            className="pointer-events-none flex size-4 shrink-0 items-center justify-center"
          >
            {icon}
          </span>
        )}
      </span>
    </TableCheckboxSlot>
  );
}

export function TableColumnResizer<T extends RowData>({
  header,
  label,
  disabled,
}: {
  header: Header<T, unknown>;
  label: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const beginResize = (
    event: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>,
  ) => {
    if (disabled) return;
    const width =
      event.currentTarget.parentElement?.getBoundingClientRect().width;
    if (width)
      flushSync(() =>
        header.getContext().table.setColumnSizing((prev) => ({
          ...prev,
          [header.column.id]: Math.max(48, Math.min(1600, width)),
        })),
      );
    header.getResizeHandler()(event);
  };
  if (!header.column.getCanResize()) return null;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("tables.resizeColumn", { column: label })}
      aria-valuenow={Math.round(header.column.getSize())}
      aria-valuemin={48}
      aria-valuemax={1600}
      tabIndex={disabled ? -1 : 0}
      className="absolute top-1.5 right-0 bottom-1.5 z-20 w-1 cursor-col-resize touch-none rounded-full transition-colors duration-100 hover:bg-foreground/20 focus-visible:bg-primary focus-visible:outline-2 focus-visible:outline-ring after:absolute after:-inset-x-1 after:inset-y-0 after:content-['']"
      onDoubleClick={() => {
        if (!disabled) header.column.resetSize();
      }}
      onMouseDown={beginResize}
      onTouchStart={beginResize}
      onKeyDown={(event) => {
        if (
          disabled ||
          !["ArrowLeft", "ArrowRight", "Home"].includes(event.key)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const width =
          event.currentTarget.parentElement?.getBoundingClientRect().width ??
          header.column.getSize();
        const delta = event.key === "ArrowRight" ? 16 : -16;
        if (event.key === "Home") header.column.resetSize();
        else
          header.getContext().table.setColumnSizing((prev) => ({
            ...prev,
            [header.column.id]: Math.max(48, Math.min(1600, width + delta)),
          }));
      }}
    />
  );
}
