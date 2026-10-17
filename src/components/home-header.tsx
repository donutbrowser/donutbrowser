"use client";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GoPlus } from "react-icons/go";
import { useWindowDecorations } from "@/hooks/use-window-decorations";
import { getCurrentOS } from "@/lib/browser-utils";
import type { ProfileSearchContext } from "@/lib/profile-search";
import { cn } from "@/lib/utils";
import type { BrowserProfile, GroupWithCount } from "@/types";
import { UNGROUPED_DROP_ID, useProfileGroupDrag } from "./profile-group-drag";
import { ProfileSearchInput } from "./profile-search-input";
import { Button } from "./ui/button";
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
}: Props) => {
  const { t } = useTranslation();
  const profileDrag = useProfileGroupDrag();
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
        <span className="ml-2 text-xs font-semibold text-card-foreground">
          {pageTitle}
        </span>
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
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  onGroupSelect(ALL_FILTER_ID);
                }}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-1.5 px-1 text-xs transition-colors duration-100",
                  active
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span>{t("groups.all")}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {totalProfiles}
                </span>
              </button>
            );
          })()}
          {profileDrag && profileDrag.movingIds.size > 0 && (
            <span
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
              className={cn(
                "flex h-7 shrink-0 items-center rounded-sm px-2 text-xs text-muted-foreground transition-colors duration-100",
                profileDrag.targetId === UNGROUPED_DROP_ID &&
                  "bg-accent font-medium text-accent-foreground",
                !profileDrag.canDrop(UNGROUPED_DROP_ID) && "opacity-40",
              )}
            >
              {t("groups.noGroup")}
            </span>
          )}
          {groups.map((group) => {
            const active = selectedGroupId === group.id;
            const dropTarget = profileDrag?.targetId === group.id;
            return (
              <button
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
                  onGroupSelect(active ? ALL_FILTER_ID : group.id);
                }}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-1 text-xs transition-colors duration-100",
                  dropTarget && "bg-accent text-accent-foreground",
                  profileDrag?.active &&
                    !profileDrag.canDrop(group.id) &&
                    "opacity-40",
                  active
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="max-w-40 truncate">{group.name}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {group.count}
                </span>
              </button>
            );
          })}
        </ScrollStrip>
      )}

      {!showProfileToolbar && <div className="flex-1" />}

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
                data-onborda="create-profile"
                onClick={() => {
                  onCreateProfileDialogOpen(true);
                }}
                className="flex h-7 items-center gap-1.5 px-2.5 text-xs"
              >
                <GoPlus className="size-3.5" />
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
