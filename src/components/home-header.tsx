"use client";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuChevronDown, LuPlus } from "react-icons/lu";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { useWindowDecorations } from "@/hooks/use-window-decorations";
import { getCurrentOS } from "@/lib/browser-utils";
import { tipAnchor } from "@/lib/coach-mark";
import {
  MOTION_DURATION,
  MOTION_EASE_OUT,
  MOTION_SPRING,
  MOTION_SPRING_POSITION,
} from "@/lib/motion";
import type { ProfileSearchContext } from "@/lib/profile-search";
import { cn } from "@/lib/utils";
import type { BrowserProfile, GroupWithCount } from "@/types";
import { TickingCount } from "./entity-page";
import { Swap } from "./page-transition";
import { UNGROUPED_DROP_ID, useProfileGroupDrag } from "./profile-group-drag";
import { ProfileSearchInput } from "./profile-search-input";
import { type AppPage, PAGE_ICONS } from "./rail-nav";
import { SyncHealthIndicator } from "./sync-health-indicator";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { FOCUS_RING } from "./ui/focus-ring";
import { ScrollStrip } from "./ui/scroll-strip";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const HOLD_MS = 150;
const DRAG_THRESHOLD_PX = 3;

// Any interactive control (buttons, links, inputs) must NOT start a window
// drag when pressed — otherwise the press-and-hold / drag-threshold logic below
// hands the pointer to the OS window-move loop and the control's click never
// fires (e.g. the "+ New" button needing a double-click, and the window
// un-maximizing on Windows). Mirrors the guard handleDoubleClick already uses.
// A portal's content (the search suggestions, a popover) is not part of the
// bar, though React bubbles its events here: it never drags or maximizes.
const isInteractiveTarget = (
  target: EventTarget | null,
  bar: Element,
): boolean => {
  if (!(target instanceof Element)) return false;
  if (!bar.contains(target)) return true;
  const el = target.closest(
    "button, a, [role='button'], input, select, textarea, [contenteditable=''], [contenteditable='true']",
  );
  return el !== null;
};

const ALL_FILTER_ID = "__all__";

/** From this many groups on, the strip gets a menu that lists every group. */
const GROUP_MENU_THRESHOLD = 5;

// The strip scrolls and keeps 2px of padding, so the ring sits on the edge.
const STRIP_BUTTON = cn(
  "relative flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-1 text-xs transition-colors duration-100",
  FOCUS_RING,
  "focus-visible:ring-offset-0",
);

/** The underline under the active group, shared so it slides between them. */
function GroupUnderline({ animate }: { animate: boolean }) {
  return (
    <motion.span
      aria-hidden="true"
      layoutId={animate ? "group-strip-underline" : undefined}
      initial={false}
      transition={animate ? MOTION_SPRING_POSITION : { duration: 0 }}
      className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-foreground"
    />
  );
}

interface Props {
  onCreateProfileDialogOpen: (open: boolean) => void;
  /** False for a team seat that may not add profiles. */
  canCreateProfiles?: boolean;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  /** The profiles the search runs over, for its suggestions and counts. */
  searchProfiles?: readonly BrowserProfile[];
  searchContext?: ProfileSearchContext;
  groups: GroupWithCount[];
  totalProfiles: number;
  selectedGroupId: string | null;
  onGroupSelect: (groupId: string) => void;
  pageTitle?: string;
  /** The page the title names, for its icon. */
  page?: AppPage;
  /** +1 when the page lies further down the rail than the last one. */
  pageDirection?: 1 | -1;
}

const HomeHeader = ({
  onCreateProfileDialogOpen,
  canCreateProfiles = true,
  searchQuery,
  onSearchQueryChange,
  searchProfiles,
  searchContext,
  groups,
  totalProfiles,
  selectedGroupId,
  onGroupSelect,
  pageTitle,
  page,
  pageDirection = 1,
}: Props) => {
  const { t } = useTranslation();
  const profileDrag = useProfileGroupDrag();
  const motionAllowed = useMotionAllowed();
  const PageIcon = page ? PAGE_ICONS[page] : null;
  const [platform, setPlatform] = useState<string>("macos");

  useEffect(() => {
    setPlatform(getCurrentOS());
  }, []);

  const isMacOS = platform === "macos";
  const isLinux = platform === "linux";
  const showProfileToolbar = !pageTitle;

  // Same hook the controls use, so the reserved space can never disagree with
  // what is actually drawn.
  const decorations = useWindowDecorations();
  const linuxLayout = decorations.clientSide ? decorations.layout : null;

  // Press-and-hold drag: any pixel of the sys-bar becomes a drag handle after
  // HOLD_MS, but quick clicks still reach buttons/inputs underneath.
  const holdTimeoutRef = useRef<number | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartedRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const dragRootRef = useRef<HTMLDivElement | null>(null);

  const clearHold = useCallback(() => {
    if (holdTimeoutRef.current !== null) {
      window.clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }
  }, []);

  const beginDrag = useCallback(() => {
    if (dragStartedRef.current) return;
    dragStartedRef.current = true;
    clearHold();
    void getCurrentWindow().startDragging();
  }, [clearHold]);

  useEffect(() => {
    return () => {
      clearHold();
    };
  }, [clearHold]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if (isInteractiveTarget(e.target, e.currentTarget)) return;

      dragStartedRef.current = false;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      activePointerIdRef.current = e.pointerId;

      clearHold();
      holdTimeoutRef.current = window.setTimeout(() => {
        holdTimeoutRef.current = null;
        beginDrag();
      }, HOLD_MS);
    },
    [beginDrag, clearHold],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (
        dragStartedRef.current ||
        dragStartRef.current === null ||
        activePointerIdRef.current !== e.pointerId
      ) {
        return;
      }
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        beginDrag();
      }
    },
    [beginDrag],
  );

  const handlePointerEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (activePointerIdRef.current !== e.pointerId) return;
      clearHold();
      dragStartRef.current = null;
      activePointerIdRef.current = null;
      dragStartedRef.current = false;
    },
    [clearHold],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isInteractiveTarget(e.target, e.currentTarget)) return;
      clearHold();
      void getCurrentWindow().toggleMaximize();
    },
    [clearHold],
  );

  const isWindows = platform === "windows";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: titlebar drag surface; the interactive controls inside are real buttons/inputs
    <div
      ref={dragRootRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onDoubleClick={handleDoubleClick}
      className={cn(
        "flex h-11 items-center gap-2 border-b border-border bg-card select-none",
        // Windows: WindowDragArea renders three 44px native-style controls
        // (minimize + maximize/restore + close) fixed at top-right with
        // z-50, total 132px wide. Reserve 144px on the right edge so the
        // "+ New" button and search input clear them with a few pixels of
        // breathing room and never sit underneath the controls.
        isWindows ? "pl-3 pr-[144px]" : null,
        // Linux reserves its space through the inline style below, because the
        // desktop chooses which side the controls sit on and how many there
        // are. Everything else keeps the plain symmetric padding.
        !isWindows && !isLinux ? "pl-3 pr-3" : null,
      )}
      style={
        isLinux
          ? {
              // Each control is 44px wide; add the usual 12px gutter. Before
              // the layout resolves, fall back to the gutter alone rather than
              // to no padding, which would visibly shift the content.
              paddingLeft: (linuxLayout?.left.length ?? 0) * 44 + 12,
              paddingRight: (linuxLayout?.right.length ?? 0) * 44 + 12,
            }
          : undefined
      }
    >
      {/* The OS draws the traffic lights here through the transparent
          titlebar, 15px from the left edge (lib.rs). On macOS 26 they end at
          75px; this keeps the header's content a 13px gap clear of them. */}
      {isMacOS && <div aria-hidden="true" className="w-15 shrink-0" />}

      {pageTitle ? (
        <h1
          data-slot="page-title"
          className="relative ml-2 flex min-w-0 items-center text-xs font-semibold text-card-foreground"
        >
          <Swap
            swapKey={pageTitle}
            as="span"
            from={{ y: pageDirection * 8, opacity: 0.5 }}
            transition={{
              duration: MOTION_DURATION.base,
              ease: MOTION_EASE_OUT,
            }}
            className="flex min-w-0 items-center gap-2"
          >
            {PageIcon ? (
              <motion.span
                aria-hidden="true"
                className="grid size-5 shrink-0 place-items-center rounded-md bg-foreground/5 text-muted-foreground"
                initial={motionAllowed ? { scale: 0.8 } : false}
                animate={{ scale: 1 }}
                transition={MOTION_SPRING.snappy}
              >
                <PageIcon className="size-3" />
              </motion.span>
            ) : null}
            <span className="truncate">{pageTitle}</span>
          </Swap>
        </h1>
      ) : null}

      {showProfileToolbar && (
        <ScrollStrip
          data-slot="profile-group-strip"
          className="ml-2 flex-1"
          stripClassName="gap-3"
          activeKey={selectedGroupId}
          instant={Boolean(profileDrag?.active)}
          scrollLeftLabel={t("header.scrollGroupsLeft")}
          scrollRightLabel={t("header.scrollGroupsRight")}
        >
          {/* "All" filter — shows every profile regardless of group. */}
          {(() => {
            const active = selectedGroupId === ALL_FILTER_ID;
            return (
              <button
                key="__all__"
                type="button"
                {...tipAnchor("group-strip")}
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  onGroupSelect(ALL_FILTER_ID);
                }}
                className={cn(
                  STRIP_BUTTON,
                  active
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {active && <GroupUnderline animate={motionAllowed} />}
                <span>{t("groups.all")}</span>
                <TickingCount
                  value={totalProfiles}
                  className="text-[11px] text-muted-foreground"
                />
              </button>
            );
          })()}
          {profileDrag && profileDrag.movingIds.size > 0 && (
            <motion.span
              data-profile-group-drop={UNGROUPED_DROP_ID}
              data-drop-state={
                profileDrag.targetId === UNGROUPED_DROP_ID
                  ? "target"
                  : profileDrag.canDrop(UNGROUPED_DROP_ID)
                    ? "available"
                    : "unavailable"
              }
              title={t("profileMotion.dragTarget", {
                group: t("groups.noGroup"),
              })}
              animate={{
                scale: profileDrag.targetId === UNGROUPED_DROP_ID ? 1.04 : 1,
              }}
              transition={
                motionAllowed ? MOTION_SPRING.snappy : { duration: 0 }
              }
              className={cn(
                "flex h-7 shrink-0 items-center rounded-sm px-2 text-xs text-muted-foreground transition-colors duration-100",
                profileDrag.targetId === UNGROUPED_DROP_ID &&
                  "bg-foreground/8 font-medium text-foreground",
                !profileDrag.canDrop(UNGROUPED_DROP_ID) && "opacity-40",
              )}
            >
              {t("groups.noGroup")}
            </motion.span>
          )}
          {groups.map((group) => {
            const active = selectedGroupId === group.id;
            const dropTarget = profileDrag?.targetId === group.id;
            return (
              <motion.button
                key={group.id}
                type="button"
                title={group.name}
                data-profile-group-drop={group.id}
                data-drop-state={
                  profileDrag?.active
                    ? dropTarget
                      ? "target"
                      : profileDrag.canDrop(group.id)
                        ? "available"
                        : "unavailable"
                    : undefined
                }
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  onGroupSelect(group.id);
                }}
                animate={{ scale: dropTarget ? 1.04 : 1 }}
                transition={
                  motionAllowed ? MOTION_SPRING.snappy : { duration: 0 }
                }
                className={cn(
                  STRIP_BUTTON,
                  dropTarget && "bg-foreground/8 text-foreground",
                  profileDrag?.active &&
                    !profileDrag.canDrop(group.id) &&
                    "opacity-40",
                  active
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {active && <GroupUnderline animate={motionAllowed} />}
                <span className="max-w-40 truncate">{group.name}</span>
                <TickingCount
                  value={group.count}
                  className="text-[11px] text-muted-foreground"
                />
              </motion.button>
            );
          })}
        </ScrollStrip>
      )}

      {showProfileToolbar && groups.length >= GROUP_MENU_THRESHOLD && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="subtle"
                  size="sm"
                  data-slot="profile-group-menu"
                  aria-label={t("header.allGroups")}
                  className="size-7 shrink-0 p-0"
                >
                  <LuChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("header.allGroups")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="end"
            className="max-h-80 w-60"
            aria-label={t("header.allGroups")}
          >
            {[
              {
                id: ALL_FILTER_ID,
                name: t("groups.all"),
                count: totalProfiles,
              },
              ...groups,
            ].map((group) => (
              <DropdownMenuItem
                key={group.id}
                onSelect={() => {
                  onGroupSelect(group.id);
                }}
                className="gap-2 text-xs focus:bg-foreground/5 focus:text-foreground"
              >
                <LuCheck
                  aria-hidden="true"
                  className={cn(
                    "size-3.5",
                    selectedGroupId === group.id ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{group.name}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {group.count}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {!showProfileToolbar && <div className="flex-1" />}

      <SyncHealthIndicator />

      {showProfileToolbar && (
        <ProfileSearchInput
          value={searchQuery}
          onChange={onSearchQueryChange}
          profiles={searchProfiles}
          context={searchContext}
        />
      )}

      {showProfileToolbar && canCreateProfiles && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0">
              <Button
                size="sm"
                {...tipAnchor("new-profile")}
                onClick={() => {
                  onCreateProfileDialogOpen(true);
                }}
                className="flex h-7 items-center gap-1.5 px-2.5 text-xs"
              >
                <LuPlus className="size-3.5" />
                {t("header.newProfile")}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("header.createProfile")}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};

export default HomeHeader;
