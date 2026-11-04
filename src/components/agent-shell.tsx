"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { LuPanelLeft } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Below this width the sidebar leaves and opens over the main pane. */
const NARROW_PX = 720;
/** Below this width the sidebar takes less of the page. */
const COMPACT_PX = 1000;

interface ShellState {
  narrow: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
}

const ShellContext = createContext<ShellState>({
  narrow: false,
  openSidebar: () => {},
  closeSidebar: () => {},
});

/** The shell's sidebar control: closes the drawer after a choice. */
export function useAgentShell() {
  return useContext(ShellContext);
}

/**
 * The agent page: a sidebar and one main pane. On a narrow page the sidebar
 * hides, and the `SidebarToggle` in the pane's header opens it as a drawer.
 */
export function AgentShell({
  sidebar,
  children,
  label,
}: {
  sidebar: ReactNode;
  children: ReactNode;
  label: string;
}) {
  const animate = useMotionAllowed();
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [compact, setCompact] = useState(false);
  const [drawer, setDrawer] = useState(false);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      setNarrow(node.clientWidth < NARROW_PX);
      setCompact(node.clientWidth < COMPACT_PX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!narrow) setDrawer(false);
  }, [narrow]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setDrawer(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [drawer]);

  const openSidebar = useCallback(() => {
    setDrawer(true);
  }, []);
  const closeSidebar = useCallback(() => {
    setDrawer(false);
  }, []);
  const state = useMemo(
    () => ({ narrow, openSidebar, closeSidebar }),
    [narrow, openSidebar, closeSidebar],
  );

  return (
    <ShellContext.Provider value={state}>
      <div
        ref={ref}
        data-slot="agent-shell"
        data-narrow={narrow ? "true" : "false"}
        className="relative flex min-h-0 flex-1 gap-3"
      >
        {!narrow && (
          <aside
            aria-label={label}
            data-slot="agent-sidebar"
            className={cn("flex shrink-0 flex-col", compact ? "w-54" : "w-60")}
          >
            {sidebar}
          </aside>
        )}
        <AnimatePresence>
          {narrow && drawer && (
            <>
              <motion.div
                key="scrim"
                aria-hidden="true"
                initial={animate ? { opacity: 0 } : false}
                animate={{ opacity: 1 }}
                exit={
                  animate
                    ? { opacity: 0 }
                    : { opacity: 0, transition: { duration: 0 } }
                }
                transition={{ duration: MOTION_DURATION.fast }}
                className="absolute inset-0 z-20 bg-background/60"
                onClick={closeSidebar}
              />
              <motion.aside
                key="drawer"
                aria-label={label}
                data-slot="agent-sidebar"
                initial={animate ? { x: -16, opacity: 0 } : false}
                animate={{ x: 0, opacity: 1 }}
                exit={
                  animate
                    ? { x: -16, opacity: 0 }
                    : { opacity: 0, transition: { duration: 0 } }
                }
                transition={{
                  duration: MOTION_DURATION.base,
                  ease: MOTION_EASE_OUT,
                }}
                className="absolute inset-y-0 left-0 z-30 flex w-64 flex-col rounded-2xl bg-popover p-2 text-popover-foreground shadow-xl"
              >
                {sidebar}
              </motion.aside>
            </>
          )}
        </AnimatePresence>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </ShellContext.Provider>
  );
}

/** Opens the sidebar on a narrow page; renders nothing on a wide one. */
export function SidebarToggle() {
  const { t } = useTranslation();
  const { narrow, openSidebar } = useAgentShell();
  if (!narrow) return null;
  return (
    <Button
      type="button"
      variant="subtle"
      size="sm"
      data-slot="agent-sidebar-toggle"
      aria-label={t("agent.shell.showSidebar")}
      title={t("agent.shell.showSidebar")}
      onClick={openSidebar}
      className="size-8 shrink-0 rounded-xl p-0"
    >
      <LuPanelLeft className="size-4" aria-hidden="true" />
    </Button>
  );
}

/** A labelled group of sidebar rows. The label hides while it is alone. */
export function SidebarSection({
  label,
  action,
  children,
}: {
  label?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      {label && (
        <div className="flex h-7 items-center gap-2 px-2.5 pt-2">
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
            {label}
          </span>
          {action}
        </div>
      )}
      <ul aria-label={label} className="flex flex-col gap-px">
        {children}
      </ul>
    </div>
  );
}

/** The look of a sidebar row: quiet until hovered, tinted when current. */
export function sidebarRow(selected: boolean, className?: string) {
  return cn(
    "flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-xl px-2.5 text-left text-sm transition-colors duration-150 motion-reduce:transition-none",
    FOCUS_RING,
    selected
      ? "bg-foreground/7 text-foreground"
      : "text-foreground/85 hover:bg-foreground/4 hover:text-foreground",
    className,
  );
}
