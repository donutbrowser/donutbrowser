"use client";

import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuBot,
  LuCloud,
  LuCookie,
  LuDownload,
  LuEllipsis,
  LuInfo,
  LuKeyboard,
  LuLightbulb,
  LuMessageSquareHeart,
  LuPlug,
  LuPuzzle,
  LuSettings,
  LuTrash2,
  LuUser,
  LuUsers,
  LuWifi,
} from "react-icons/lu";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { type CoachAnchorId, tipAnchor } from "@/lib/coach-mark";
import { launchDonutClone } from "@/lib/donut-physics";
import { MOTION_EASE_OUT, MOTION_SPRING_POSITION } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Logo } from "./icons/logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { FOCUS_RING } from "./ui/focus-ring";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export type AppPage =
  | "profiles"
  | "proxies"
  | "extensions"
  | "groups"
  | "cookieBot"
  | "agent"
  | "vpns"
  | "settings"
  | "integrations"
  | "account"
  | "import"
  | "shortcuts"
  | "trash";

const CLICK_THRESHOLD = 5;
const CLICK_WINDOW_MS = 2000;
const LOGO_HIDDEN_KEY = "donut-logo-hidden";

function useLogoEasterEgg({
  currentPage,
  onNavigate,
}: {
  currentPage: AppPage;
  onNavigate: (page: AppPage) => void;
}) {
  const reduceMotion = useReducedMotion();
  const playfulMotion = useMotionAllowed();
  const clickTimestamps = useRef<number[]>([]);
  const [isPressed, setIsPressed] = useState(false);
  const [wobbleKey, setWobbleKey] = useState(0);
  /** Wiggles earned by the cheat code, which arrives by keyboard by nature. */
  const [cheerKey, setCheerKey] = useState(0);
  const [isFalling, setIsFalling] = useState(false);
  /**
   * Click count toward the bounce trigger while the user is on the profiles
   * page. Capped at 4: each click here grows the logo by 25%, so step 4 has
   * doubled the original size. Click 5 fires `triggerFall` and resets.
   */
  const [growStep, setGrowStep] = useState(0);
  const resetTimeoutRef = useRef<number | null>(null);
  const [isHidden, setIsHidden] = useState(() => {
    try {
      return sessionStorage.getItem(LOGO_HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const logoRef = useRef<HTMLButtonElement>(null);
  const cancelFallRef = useRef<(() => void) | null>(null);

  const triggerFall = useCallback(() => {
    const el = logoRef.current;
    if (!el || isFalling) return;
    setIsFalling(true);

    cancelFallRef.current = launchDonutClone(el, {
      onExit: () => {
        try {
          sessionStorage.setItem(LOGO_HIDDEN_KEY, "1");
        } catch {
          // ignore — sessionStorage unavailable in some Tauri WebViews
        }
        setIsHidden(true);
        setIsFalling(false);
      },
    });
  }, [isFalling]);

  useEffect(() => {
    return () => {
      cancelFallRef.current?.();
    };
  }, []);

  const handleClick = useCallback(() => {
    if (isFalling || isHidden) return;

    // First behaviour: any click from elsewhere in the app just routes the
    // user back to the profiles list. Growing the donut requires the user
    // to already be home — that keeps the easter egg from accidentally
    // firing during normal navigation.
    if (currentPage !== "profiles") {
      onNavigate("profiles");
      clickTimestamps.current = [];
      setGrowStep(0);
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current);
        resetTimeoutRef.current = null;
      }
      return;
    }

    if (!playfulMotion) return;

    const now = Date.now();
    clickTimestamps.current = clickTimestamps.current.filter(
      (t) => now - t < CLICK_WINDOW_MS,
    );
    clickTimestamps.current.push(now);

    if (clickTimestamps.current.length >= CLICK_THRESHOLD) {
      clickTimestamps.current = [];
      setGrowStep(0);
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current);
        resetTimeoutRef.current = null;
      }
      triggerFall();
    } else {
      setGrowStep(
        Math.min(clickTimestamps.current.length, CLICK_THRESHOLD - 1),
      );
      setWobbleKey((k) => k + 1);
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current);
      }
      resetTimeoutRef.current = window.setTimeout(() => {
        clickTimestamps.current = [];
        setGrowStep(0);
        resetTimeoutRef.current = null;
      }, CLICK_WINDOW_MS);
    }
  }, [
    currentPage,
    isFalling,
    isHidden,
    onNavigate,
    triggerFall,
    playfulMotion,
  ]);

  // Leaving the profiles page mid-streak cancels growth so we never end up
  // with an outsized logo when the user returns later.
  useEffect(() => {
    if (currentPage !== "profiles" || !playfulMotion) {
      clickTimestamps.current = [];
      setGrowStep(0);
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current);
        resetTimeoutRef.current = null;
      }
    }
  }, [currentPage, playfulMotion]);

  // The cheat code (see useKonamiCode) is received with the same wiggle a
  // click earns, so the donut visibly takes the credit. It is typed, so the
  // pointer-only gate on click wiggles cannot apply; only reduced motion does.
  useEffect(() => {
    if (reduceMotion) return;
    const onCheatCode = () => setCheerKey((k) => k + 1);
    window.addEventListener("donut-cheat-code", onCheatCode);
    return () => {
      window.removeEventListener("donut-cheat-code", onCheatCode);
    };
  }, [reduceMotion]);

  useEffect(() => {
    if (!reduceMotion) return;
    cancelFallRef.current?.();
    cancelFallRef.current = null;
    setIsFalling(false);
    setIsPressed(false);
    if (logoRef.current) logoRef.current.style.visibility = "";
  }, [reduceMotion]);

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current);
      }
    };
  }, []);

  return {
    logoRef,
    isPressed,
    setIsPressed,
    wobbleKey,
    cheerKey,
    isFalling,
    isHidden,
    growStep,
    handleClick,
    playfulMotion,
  };
}

type PageIcon = React.ComponentType<{ className?: string }>;

/** The icon each page wears in the rail and in the header title. */
export const PAGE_ICONS: Record<AppPage, PageIcon> = {
  profiles: LuUser,
  proxies: LuWifi,
  vpns: LuWifi,
  extensions: LuPuzzle,
  groups: LuUsers,
  cookieBot: LuCookie,
  agent: LuBot,
  integrations: LuPlug,
  account: LuCloud,
  import: LuDownload,
  shortcuts: LuKeyboard,
  trash: LuTrash2,
  settings: LuSettings,
};

/** Rail order, top to bottom: page transitions move in this direction. */
const PAGE_ORDER: AppPage[] = [
  "profiles",
  "proxies",
  "extensions",
  "groups",
  "cookieBot",
  "agent",
  "integrations",
  "account",
  "import",
  "shortcuts",
  "trash",
  "settings",
];

function pageIndex(page: AppPage): number {
  return PAGE_ORDER.indexOf(page === "vpns" ? "proxies" : page);
}

/** +1 when `to` is further down the rail than `from`, -1 when it is above. */
export function pageDirection(from: AppPage, to: AppPage): 1 | -1 {
  return pageIndex(to) >= pageIndex(from) ? 1 : -1;
}

interface RailNavProps {
  currentPage: AppPage;
  onNavigate: (page: AppPage) => void;
  onOpenAbout: () => void;
  /** Opens the feature tips catalog. */
  onOpenTips: () => void;
  onOpenFeedback: () => void;
  /**
   * A remote session is running right now. The Cookie Bot item carries a dot so
   * the state is legible from every other page — an overnight job you cannot
   * see from where you are standing may as well not be observable at all.
   */
  cookieBotRunning?: boolean;
  /** Open agent questions and help requests waiting for the person. */
  agentRequests?: number;
}

const BADGE_SPRING = { type: "spring" as const, stiffness: 600, damping: 26 };

const RAIL_BUTTON = cn(
  "relative grid size-7 shrink-0 cursor-pointer place-items-center rounded-md transition-colors duration-100",
  FOCUS_RING,
);

/**
 * The active item's pill, shared between the rail items so the whole pill
 * glides to the next page, its 2px bar with it.
 */
function ActivePill() {
  const animate = useMotionAllowed();
  return (
    <motion.span
      aria-hidden="true"
      initial={false}
      layoutId={animate ? "rail-active-pill" : undefined}
      transition={animate ? MOTION_SPRING_POSITION : { duration: 0 }}
      data-slot="rail-active-pill"
      className="absolute inset-0 rounded-md bg-foreground/8"
    >
      <span className="absolute inset-y-1.5 left-[-7px] w-[2px] rounded-full bg-foreground" />
    </motion.span>
  );
}

/**
 * Pings a badge twice when `signal` changes to a new truthy value: a run
 * that starts, a request that arrives. Decorative.
 */
function usePing(signal: number): number {
  const animate = useMotionAllowed();
  const previous = useRef(signal);
  const [ping, setPing] = useState(0);
  useEffect(() => {
    if (signal > previous.current && animate) setPing((n) => n + 1);
    previous.current = signal;
  }, [signal, animate]);
  return ping;
}

function Ping({ id, className }: { id: number; className: string }) {
  const [done, setDone] = useState<number | null>(null);
  if (id === 0 || done === id) return null;
  return (
    <motion.span
      key={id}
      aria-hidden="true"
      className={cn("pointer-events-none absolute rounded-full", className)}
      initial={{ scale: 1, opacity: 0.7 }}
      animate={{ scale: 2.6, opacity: 0 }}
      transition={{ duration: 0.8, ease: MOTION_EASE_OUT, repeat: 1 }}
      onAnimationComplete={() => setDone(id)}
    />
  );
}

function RunningDot({ running }: { running: boolean }) {
  const animate = useMotionAllowed();
  const ping = usePing(running ? 1 : 0);
  if (!running) return null;
  return (
    <>
      <Ping id={ping} className="top-1 right-1 size-1.5 bg-success" />
      <motion.span
        aria-hidden="true"
        className="absolute top-1 right-1 size-1.5 rounded-full bg-success"
        initial={animate ? { scale: 0 } : false}
        animate={{ scale: 1 }}
        transition={animate ? BADGE_SPRING : { duration: 0 }}
      />
    </>
  );
}

function WaitingBadge({ count }: { count: number }) {
  const animate = useMotionAllowed();
  const ping = usePing(count);
  if (count <= 0) return null;
  return (
    <>
      <Ping id={ping} className="-top-1 -right-1 size-4 bg-warning" />
      <motion.span
        aria-hidden="true"
        data-testid="agent-rail-badge"
        className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-warning px-1 text-[11px] leading-none font-semibold tabular-nums text-warning-foreground"
        // The count is the content, so it starts half grown, never unseen.
        initial={animate ? { scale: 0.5 } : false}
        animate={{ scale: 1 }}
        transition={animate ? BADGE_SPRING : { duration: 0 }}
      >
        {count > 9 ? "9+" : count}
      </motion.span>
    </>
  );
}

interface RailItem {
  page: AppPage;
  labelKey: string;
  /** Where a feature tip points when its feature lives on this page. */
  anchor: CoachAnchorId;
}

const TOP_ITEMS: RailItem[] = [
  { page: "profiles", labelKey: "rail.profiles", anchor: "rail-profiles" },
  { page: "proxies", labelKey: "rail.network", anchor: "rail-proxies" },
  {
    page: "extensions",
    labelKey: "rail.extensions",
    anchor: "rail-extensions",
  },
  { page: "groups", labelKey: "rail.groups", anchor: "rail-groups" },
  { page: "cookieBot", labelKey: "rail.cookieBot", anchor: "rail-cookieBot" },
  { page: "agent", labelKey: "rail.agent", anchor: "rail-agent" },
  {
    page: "integrations",
    labelKey: "rail.integrations",
    anchor: "rail-integrations",
  },
  { page: "account", labelKey: "rail.account", anchor: "rail-account" },
];

interface MoreMenuItem {
  id: string;
  Icon: PageIcon;
  labelKey: string;
  hintKey: string;
  slot?: string;
}

const MORE_PAGES: Array<MoreMenuItem & { page: AppPage }> = [
  {
    id: "import",
    page: "import",
    Icon: PAGE_ICONS.import,
    labelKey: "rail.more.importProfile",
    hintKey: "rail.more.importProfileHint",
  },
  {
    id: "shortcuts",
    page: "shortcuts",
    Icon: PAGE_ICONS.shortcuts,
    labelKey: "rail.more.keyboardShortcuts",
    hintKey: "rail.more.keyboardShortcutsHint",
  },
  {
    id: "trash",
    page: "trash",
    Icon: PAGE_ICONS.trash,
    labelKey: "rail.more.trash",
    hintKey: "rail.more.trashHint",
  },
];

const MORE_ITEM_CLASS =
  "gap-2 px-2 py-1.5 focus:bg-foreground/5 focus:text-foreground";

export function RailNav({
  currentPage,
  onNavigate,
  onOpenAbout,
  onOpenTips,
  onOpenFeedback,
  cookieBotRunning = false,
  agentRequests = 0,
}: RailNavProps) {
  const { t } = useTranslation();
  const {
    logoRef,
    isPressed,
    setIsPressed,
    wobbleKey,
    cheerKey,
    isFalling,
    isHidden,
    growStep,
    handleClick,
    playfulMotion,
  } = useLogoEasterEgg({ currentPage, onNavigate });

  const moreActions: Array<MoreMenuItem & { run: () => void }> = [
    ...MORE_PAGES.map((item) => ({
      ...item,
      run: () => onNavigate(item.page),
    })),
    {
      id: "tips",
      Icon: LuLightbulb,
      labelKey: "rail.more.tips",
      hintKey: "rail.more.tipsHint",
      slot: "rail-open-tips",
      run: onOpenTips,
    },
    {
      id: "feedback",
      Icon: LuMessageSquareHeart,
      labelKey: "rail.more.feedback",
      hintKey: "rail.more.feedbackHint",
      slot: "rail-open-feedback",
      run: onOpenFeedback,
    },
    {
      id: "about",
      Icon: LuInfo,
      labelKey: "rail.more.about",
      hintKey: "rail.more.aboutHint",
      run: onOpenAbout,
    },
  ];

  return (
    <nav className="relative flex w-10 shrink-0 flex-col items-center gap-1 border-r border-border bg-background py-2">
      {!isHidden ? (
        <button
          ref={logoRef}
          type="button"
          aria-label={t("header.donutLogo")}
          className={cn(
            "grid size-7 shrink-0 cursor-pointer place-items-center rounded-md bg-transparent text-foreground select-none",
            FOCUS_RING,
          )}
          onClick={handleClick}
          onPointerDown={() => {
            setIsPressed(true);
          }}
          onPointerUp={() => {
            setIsPressed(false);
          }}
          onPointerLeave={() => {
            setIsPressed(false);
          }}
        >
          {/* Inner wrapper survives clicks (no `key`) so the scale change
              animates smoothly across the wiggle layer's remounts. */}
          <span
            style={{
              transform: !playfulMotion
                ? "none"
                : isPressed
                  ? `scale(${(1 + growStep * 0.25) * 0.9})`
                  : `scale(${1 + growStep * 0.25})`,
            }}
            className="inline-grid place-items-center transition-transform duration-300 ease-out motion-reduce:transition-none"
          >
            <span
              key={`${wobbleKey}:${cheerKey}`}
              className={cn(
                "inline-grid place-items-center",
                !isFalling &&
                  !isPressed &&
                  ((playfulMotion && wobbleKey > 0) || cheerKey > 0) &&
                  "animate-[wiggle_0.3s_ease-in-out]",
              )}
            >
              <Logo className="size-5 will-change-transform" />
            </span>
          </span>
        </button>
      ) : (
        <div className="size-7 shrink-0" />
      )}

      <div className="my-1 h-px w-5 shrink-0 bg-border" />

      <div className="flex min-h-0 w-full scrollbar-none flex-col items-center gap-1 overflow-y-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {TOP_ITEMS.map(({ page, labelKey, anchor }) => {
          const Icon = PAGE_ICONS[page];
          const active =
            currentPage === page ||
            (page === "proxies" && currentPage === "vpns");
          const waiting = page === "agent" ? agentRequests : 0;
          const label =
            waiting > 0
              ? t("rail.agentWaiting", { count: waiting })
              : page === "cookieBot" && cookieBotRunning
                ? t("rail.cookieBotRunning")
                : t(labelKey);
          return (
            <Tooltip key={page} delayDuration={300}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  {...tipAnchor(anchor, "right")}
                  onClick={() => {
                    onNavigate(page);
                  }}
                  aria-label={label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    RAIL_BUTTON,
                    active
                      ? "text-foreground"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                  )}
                >
                  {active && <ActivePill />}
                  <Icon className="relative size-3.5" />
                  {page === "cookieBot" && (
                    <RunningDot running={cookieBotRunning} />
                  )}
                  {page === "agent" && <WaitingBadge count={waiting} />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div className="flex-1" />

      <DropdownMenu>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                {...tipAnchor("rail-more", "right")}
                aria-label={t("rail.more.label")}
                className={cn(
                  RAIL_BUTTON,
                  "text-muted-foreground hover:bg-foreground/5 hover:text-foreground aria-expanded:bg-foreground/8 aria-expanded:text-foreground",
                )}
              >
                <LuEllipsis className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">{t("rail.more.label")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          side="right"
          align="end"
          sideOffset={8}
          aria-label={t("rail.more.label")}
          className="w-56"
        >
          {moreActions.map(({ id, Icon, labelKey, hintKey, slot, run }) => (
            <DropdownMenuItem
              key={id}
              data-slot={slot}
              onSelect={run}
              className={MORE_ITEM_CLASS}
            >
              <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
                <Icon className="size-3" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-xs font-medium text-foreground">
                  {t(labelKey)}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {t(hintKey)}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            type="button"
            {...tipAnchor("rail-settings", "right")}
            onClick={() => {
              onNavigate("settings");
            }}
            aria-label={t("rail.settings")}
            aria-current={currentPage === "settings" ? "page" : undefined}
            className={cn(
              RAIL_BUTTON,
              currentPage === "settings"
                ? "text-foreground"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            {currentPage === "settings" && <ActivePill />}
            <LuSettings className="relative size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{t("rail.settings")}</TooltipContent>
      </Tooltip>
    </nav>
  );
}
