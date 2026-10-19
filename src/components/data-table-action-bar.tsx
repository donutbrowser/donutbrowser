"use client";

import type { RowData } from "@tanstack/react-table";
import type { LegacyTable as Table } from "@tanstack/react-table/legacy";
import { motion } from "motion/react";
import * as React from "react";
import * as ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import { LuX } from "react-icons/lu";
import { TickingCount } from "@/components/entity-page";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_DURATION, MOTION_EASE_IN, MOTION_EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * How many rows are selected, and how many of those a search or filter hides.
 * The tables filter their data before the table sees it, so a selected row
 * that is filtered out is in the selection state but not in the row model.
 */
export function tableSelectionCounts<TData extends RowData>(
  table: Table<TData>,
) {
  const selection = table.atoms.rowSelection?.get() ?? {};
  const rows = table.getCoreRowModel().rowsById;
  let selected = 0;
  let hidden = 0;
  for (const [id, on] of Object.entries(selection)) {
    if (!on) continue;
    selected++;
    if (!rows[id]) hidden++;
  }
  return { selected, hidden };
}

/** Longest a leaving bar stays on screen, finished or not. */
const EXIT_FALLBACK_MS = 200;

/** Quiet buttons for the bar: no fill at rest, a foreground tint on hover. */
export const ACTION_BAR_BUTTON_CLASS =
  "text-foreground hover:bg-foreground/5 hover:text-foreground active:bg-foreground/8 aria-expanded:bg-foreground/8 aria-expanded:text-foreground";

interface DataTableActionBarProps<TData extends RowData>
  extends React.ComponentProps<typeof motion.div> {
  table: Table<TData>;
  visible?: boolean;
  portalContainer?: Element | DocumentFragment | null;
}

function DataTableActionBar<TData extends RowData>({
  table,
  visible: visibleProp,
  portalContainer: portalContainerProp,
  children,
  className,
  ...props
}: DataTableActionBarProps<TData>) {
  const motionAllowed = useMotionAllowed();
  const [mounted, setMounted] = React.useState(false);
  const barRef = React.useRef<HTMLDivElement>(null);
  const visible = visibleProp ?? tableSelectionCounts(table).selected > 0;
  React.useLayoutEffect(() => {
    setMounted(true);
  }, []);
  React.useLayoutEffect(() => {
    const bar = barRef.current;
    if (!mounted || !visible || !bar) return;
    const style = document.documentElement.style;
    const measure = () =>
      style.setProperty("--table-action-bar-height", `${bar.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      style.removeProperty("--table-action-bar-height");
    };
  }, [mounted, visible]);

  React.useEffect(() => {
    if (!visible) return;
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector('[data-slot="dialog-content"]')
      ) {
        table.resetRowSelection(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [table, visible]);

  // The bar plays its exit, but leaves after EXIT_FALLBACK_MS even when the
  // animation clock is paused and the exit never finishes.
  const [leaving, setLeaving] = React.useState(false);
  const wasVisible = React.useRef(visible);
  React.useEffect(() => {
    const left = wasVisible.current && !visible;
    wasVisible.current = visible;
    if (!left || !motionAllowed) {
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => setLeaving(false), EXIT_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [visible, motionAllowed]);

  const portalContainer =
    portalContainerProp ?? (mounted ? globalThis.document.body : null);

  if (!portalContainer || !(visible || leaving)) return null;

  return ReactDOM.createPortal(
    <motion.div
      ref={barRef}
      data-slot="table-action-bar"
      role="toolbar"
      aria-orientation="horizontal"
      aria-hidden={visible ? undefined : true}
      inert={!visible}
      initial={motionAllowed ? { y: 8, opacity: 0.5 } : false}
      animate={
        visible
          ? {
              y: 0,
              opacity: 1,
              transition: {
                duration: motionAllowed ? MOTION_DURATION.base : 0,
                ease: MOTION_EASE_OUT,
              },
            }
          : {
              y: 8,
              opacity: 0,
              transition: {
                duration: MOTION_DURATION.fast,
                ease: MOTION_EASE_IN,
              },
            }
      }
      onAnimationComplete={() => {
        if (!visible) setLeaving(false);
      }}
      className={cn(
        "surface-material-popover fixed inset-x-0 bottom-6 z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center justify-center gap-1.5 rounded-xl p-1.5 text-foreground shadow-lg ring-1 ring-foreground/8",
        !visible && "pointer-events-none",
        className,
      )}
      {...props}
    >
      {children}
    </motion.div>,
    portalContainer,
  );
}

interface DataTableActionBarActionProps
  extends React.ComponentProps<typeof Button> {
  tooltip?: string;
  label?: string;
  isPending?: boolean;
}

function DataTableActionBarAction({
  size = "sm",
  tooltip,
  label,
  isPending,
  disabled,
  className,
  children,
  ...props
}: DataTableActionBarActionProps) {
  const trigger = (
    <Button
      variant="subtle"
      size={size}
      className={cn(
        "gap-1.5 rounded-lg text-xs [&>svg]:size-3.5",
        ACTION_BAR_BUTTON_CLASS,
        size === "icon" ? "size-7" : "h-7",
        className,
      )}
      disabled={disabled || isPending}
      aria-label={label ?? tooltip}
      {...props}
    >
      {isPending ? (
        <div className="size-3.5 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" />
      ) : (
        children
      )}
      {size !== "icon" && (label ?? tooltip) && <span>{label ?? tooltip}</span>}
    </Button>
  );

  if (!tooltip) return trigger;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent sideOffset={6}>
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}

const COUNT_MARK = "\u2063";

/**
 * A translated sentence with its numbers rolling: each value goes in as a
 * marker, and the markers come back out as ticking counts.
 */
function CountSentence({
  text,
  values,
}: {
  text: string;
  values: Record<string, number>;
}) {
  const parts = text.split(COUNT_MARK);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 && part in values ? (
          <TickingCount
            key={part}
            value={values[part]}
            slot={`table-selection-${part}`}
          />
        ) : (
          part
        ),
      )}
    </>
  );
}

interface DataTableActionBarSelectionProps<TData extends RowData> {
  table: Table<TData>;
}

function DataTableActionBarSelection<TData extends RowData>({
  table,
}: DataTableActionBarSelectionProps<TData>) {
  const { t } = useTranslation();
  const counts = tableSelectionCounts(table);
  // A leaving bar keeps the counts it had, not the zero that sent it away.
  const last = React.useRef(counts);
  if (counts.selected > 0) last.current = counts;
  const { selected, hidden } = counts.selected > 0 ? counts : last.current;
  const mark = (name: string) => `${COUNT_MARK}${name}${COUNT_MARK}`;
  const label =
    hidden > 0
      ? t("dataTableActionBar.selectedHidden", { selected, hidden })
      : t("dataTableActionBar.selected", { count: selected });
  const marked =
    hidden > 0
      ? t("dataTableActionBar.selectedHidden", {
          selected: mark("selected"),
          hidden: mark("hidden"),
        })
      : t("dataTableActionBar.selected", { count: mark("selected") });

  return (
    <div className="flex h-7 items-center pr-1 pl-2">
      <span
        data-slot="table-selection-count"
        className="text-xs font-medium whitespace-nowrap tabular-nums"
      >
        <span aria-hidden="true">
          <CountSentence text={marked} values={{ selected, hidden }} />
        </span>
        <span className="sr-only">{label}</span>
      </span>
      <div className="mr-1 ml-2 h-4 w-px bg-foreground/10" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="subtle"
            size="icon"
            className={cn("size-5 rounded-md", ACTION_BAR_BUTTON_CLASS)}
            aria-label={t("dataTableActionBar.clearSelection")}
            aria-keyshortcuts="Escape"
            onClick={() => table.resetRowSelection(true)}
          >
            <LuX className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent
          sideOffset={10}
          className="flex items-center gap-2 px-2 py-1"
        >
          <p>{t("dataTableActionBar.clearSelection")}</p>
          <kbd className="rounded bg-primary-foreground/15 px-1.5 py-px font-mono text-[11px] select-none">
            <abbr title={t("common.keys.escape")} className="no-underline">
              Esc
            </abbr>
          </kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export {
  DataTableActionBar,
  DataTableActionBarAction,
  DataTableActionBarSelection,
};
