"use client";

import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, Search } from "lucide-react";
import { motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Input } from "@/components/ui/input";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { translateBackendError } from "@/lib/backend-errors";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";

type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
type LevelFilter = "all" | "warn" | "error";

interface LogLine {
  key: string;
  time: string;
  level: LogLevel;
  target: string;
  message: string;
}

const LIMIT = 500;
const REFRESH_MS = 2000;
/** New lines animate only at the end of the list, where they arrive. */
const ANIMATED_TAIL = 40;
const STICK_DISTANCE_PX = 24;

const LEVEL_FILTERS: LevelFilter[] = ["all", "warn", "error"];

const LEVEL_CLASS: Record<LogLevel, string> = {
  trace: "text-muted-foreground",
  debug: "text-muted-foreground",
  info: "text-muted-foreground",
  warn: "text-warning",
  error: "text-destructive",
};

function lineText(line: LogLine): string {
  return `[${line.time}][${line.target}][${line.level.toUpperCase()}] ${line.message}`;
}

/** Visible on screen and in a window the person is looking at. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [intersecting, setIntersecting] = useState(true);
  const [pageVisible, setPageVisible] = useState(
    typeof document === "undefined" || document.visibilityState === "visible",
  );
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      setIntersecting(entry?.isIntersecting ?? true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  useEffect(() => {
    const onChange = () =>
      setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return intersecting && pageVisible;
}

export function LogViewer({ profileId }: { profileId?: string }) {
  const { t } = useTranslation();
  const motionAllowed = useMotionAllowed();
  const [level, setLevel] = useState<LevelFilter>("all");
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToEnd = useRef(true);
  const known = useRef<Set<string> | null>(null);
  const onScreen = useOnScreen(rootRef);

  const load = useCallback(async () => {
    try {
      const next = await invoke<LogLine[]>("read_app_log", {
        profileId: profileId ?? null,
        level: level === "all" ? null : level,
        limit: LIMIT,
      });
      const previous = known.current;
      known.current = new Set(next.map((line) => line.key));
      setFresh(
        previous
          ? new Set(
              next
                .filter((line) => !previous.has(line.key))
                .map((line) => line.key),
            )
          : new Set(),
      );
      setLines(next);
      setError(null);
    } catch (err) {
      setError(translateBackendError(t, err));
    } finally {
      setLoaded(true);
    }
  }, [profileId, level, t]);

  // A new filter is a new list: it appears at once, without animation.
  useEffect(() => {
    known.current = null;
    stickToEnd.current = true;
    void load();
  }, [load]);

  useEffect(() => {
    if (!onScreen) return;
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [onScreen, load]);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return lines;
    return lines.filter(
      (line) =>
        line.message.toLowerCase().includes(needle) ||
        line.target.toLowerCase().includes(needle),
    );
  }, [lines, search]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToEnd.current && shown.length > 0) {
      element.scrollTop = element.scrollHeight;
    }
  }, [shown]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    stickToEnd.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <
      STICK_DISTANCE_PX;
  };

  const copy = async () => {
    try {
      await writeText(shown.map(lineText).join("\n"));
      showSuccessToast(t("logViewer.copied"), {
        description: t("logViewer.copiedDescription", { count: shown.length }),
      });
    } catch (err) {
      showErrorToast(t("logViewer.copyFailed"), {
        description: translateBackendError(t, err),
      });
    }
  };

  const filterLabel: Record<LevelFilter, string> = {
    all: t("logViewer.levels.all"),
    warn: t("logViewer.levels.warn"),
    error: t("logViewer.levels.error"),
  };

  const emptyText = error
    ? error
    : !loaded
      ? t("common.buttons.loading")
      : lines.length === 0
        ? profileId
          ? t("logViewer.emptyProfile")
          : t("logViewer.empty")
        : t("logViewer.noMatches");

  return (
    <div ref={rootRef} className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <fieldset
          aria-label={t("logViewer.levelFilter")}
          className="flex items-center gap-1"
        >
          {LEVEL_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={level === value}
              onClick={() => setLevel(value)}
              className={cn(
                "h-7 rounded-full px-3 text-xs transition-colors",
                FOCUS_RING,
                level === value
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              )}
            >
              {filterLabel[value]}
            </button>
          ))}
        </fieldset>
        <div className="relative min-w-40 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            variant="soft"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("logViewer.searchPlaceholder")}
            aria-label={t("logViewer.searchPlaceholder")}
            className="h-8 pl-8 text-xs md:text-xs"
          />
        </div>
        <Button
          type="button"
          variant="soft"
          size="sm"
          onClick={() => void copy()}
          disabled={shown.length === 0}
          aria-label={t("logViewer.copyAria", { count: shown.length })}
        >
          <Copy aria-hidden className="size-3.5" />
          {t("common.buttons.copy")}
        </Button>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="off"
        aria-label={t("logViewer.title")}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the scrolling log takes keyboard scrolling
        tabIndex={0}
        className={cn(
          "h-80 overflow-y-auto overflow-x-hidden rounded-lg bg-foreground/5 py-1.5 font-mono text-[11px] leading-[1.45]",
          FOCUS_RING,
        )}
      >
        {shown.length === 0 ? (
          <p className="px-3 py-6 text-center font-sans text-xs text-muted-foreground">
            {emptyText}
          </p>
        ) : (
          shown.map((line, index) => {
            const content = (
              <>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {line.time.slice(11)}
                </span>
                <span
                  className={cn(
                    "w-10 shrink-0 font-medium uppercase",
                    LEVEL_CLASS[line.level],
                  )}
                >
                  {line.level}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                  <span className="text-muted-foreground">{line.target} </span>
                  <span
                    className={
                      line.level === "error"
                        ? "text-destructive"
                        : "text-foreground"
                    }
                  >
                    {line.message}
                  </span>
                </span>
              </>
            );
            const rowClass =
              "flex gap-2 px-3 py-px hover:bg-foreground/5 select-text";
            const animate =
              motionAllowed &&
              fresh.has(line.key) &&
              index >= shown.length - ANIMATED_TAIL;
            return animate ? (
              <motion.div
                key={line.key}
                className={rowClass}
                title={line.time}
                initial={{ opacity: 0.6, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: MOTION_DURATION.base,
                  ease: MOTION_EASE_OUT,
                }}
              >
                {content}
              </motion.div>
            ) : (
              <div key={line.key} className={rowClass} title={line.time}>
                {content}
              </div>
            );
          })
        )}
      </div>
      {lines.length >= LIMIT && (
        <p className="text-[11px] text-muted-foreground">
          {t("logViewer.capped", { count: LIMIT })}
        </p>
      )}
    </div>
  );
}
