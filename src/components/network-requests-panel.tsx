"use client";

import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Circle, Eraser, Radio, Square } from "lucide-react";
import { motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { translateBackendError } from "@/lib/backend-errors";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";

interface RequestSummary {
  id: number;
  method: string;
  url: string;
  type: string;
  state: "pending" | "done" | "failed" | "redirected" | "incomplete";
  status: number | null;
  mime: string | null;
  bytes: number | null;
  ms: number | null;
}

interface RequestList {
  capturing: boolean;
  requests?: RequestSummary[];
  last_id?: number;
  withheld?: number;
}

interface RequestDetail extends RequestSummary {
  status_text: string | null;
  protocol: string | null;
  from_cache: boolean;
  error: string | null;
  request_headers: Record<string, unknown>;
  response_headers: Record<string, unknown>;
  post_data: string | null;
  post_data_truncated: boolean;
}

const POLL_MS = 1000;
const LIST_LIMIT = 500;
const ANIMATED_TAIL = 30;
const STICK_DISTANCE_PX = 24;
const GRID =
  "grid grid-cols-[3.5rem_3rem_minmax(0,1fr)_minmax(0,1.4fr)_4.5rem_4rem_4rem] gap-2";

function splitUrl(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url.replace(/…$/, ""));
    return { host: parsed.host, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { host: "", path: url };
  }
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return "–";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMs(ms: number | null): string {
  if (ms === null || ms === undefined) return "–";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function statusClass(request: RequestSummary): string {
  if (request.state === "failed" || (request.status ?? 0) >= 400) {
    return "text-destructive";
  }
  if (request.state === "pending") return "text-muted-foreground";
  if ((request.status ?? 0) >= 300) return "text-warning";
  return "text-foreground";
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    typeof document === "undefined" || document.visibilityState === "visible",
  );
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

function Headers({
  title,
  headers,
}: {
  title: string;
  headers: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const entries = Object.entries(headers);
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-xs font-medium text-foreground">{title}</h4>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("networkPanel.noHeaders")}
        </p>
      ) : (
        <dl className="rounded-md bg-foreground/5 px-2.5 py-1.5 font-mono text-[11px] leading-[1.5]">
          {entries.map(([name, value]) => (
            <div key={name} className="flex gap-2">
              <dt className="shrink-0 text-muted-foreground">{name}:</dt>
              <dd className="min-w-0 break-all text-foreground">
                {String(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function NetworkRequestsPanel({
  profileId,
  running,
}: {
  profileId: string;
  running: boolean;
}) {
  const { t } = useTranslation();
  const motionAllowed = useMotionAllowed();
  const pageVisible = usePageVisible();
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [withheld, setWithheld] = useState(0);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const clearedAfter = useRef(0);
  const lastId = useRef(0);
  const known = useRef<Set<number> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToEnd = useRef(true);

  const reset = useCallback(() => {
    setRequests([]);
    setFresh(new Set());
    setSelected(null);
    setDetail(null);
    setWithheld(0);
    known.current = null;
    clearedAfter.current = 0;
  }, []);

  const poll = useCallback(async () => {
    try {
      const list = await invoke<RequestList>("list_network_requests", {
        profileId,
        after: clearedAfter.current,
        limit: LIST_LIMIT,
      });
      if (!list.capturing) {
        setCapturing(false);
        return;
      }
      setCapturing(true);
      const next = list.requests ?? [];
      lastId.current = list.last_id ?? lastId.current;
      const previous = known.current;
      known.current = new Set(next.map((request) => request.id));
      setFresh(
        previous
          ? new Set(
              next
                .filter((request) => !previous.has(request.id))
                .map((request) => request.id),
            )
          : new Set(),
      );
      setRequests(next);
      setWithheld(list.withheld ?? 0);
    } catch (error) {
      console.warn("Failed to read the network capture:", error);
    }
  }, [profileId]);

  useEffect(() => {
    reset();
    if (running) void poll();
    else setCapturing(false);
  }, [running, poll, reset]);

  useEffect(() => {
    if (!running || !capturing || !pageVisible) return;
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(id);
  }, [running, capturing, pageVisible, poll]);

  const selectedSummary = requests.find((request) => request.id === selected);
  const selectedState = selectedSummary
    ? `${selectedSummary.state}:${selectedSummary.status}`
    : null;

  useEffect(() => {
    if (selected === null || selectedState === null) return;
    let cancelled = false;
    void invoke<RequestDetail | null>("get_network_request", {
      profileId,
      requestId: selected,
    })
      .then((value) => {
        if (!cancelled) setDetail(value);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, selected, selectedState]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToEnd.current && requests.length > 0) {
      element.scrollTop = element.scrollHeight;
    }
  }, [requests]);

  const start = async () => {
    setBusy(true);
    try {
      await invoke("start_network_capture", { profileId });
      reset();
      setCapturing(true);
      stickToEnd.current = true;
      await poll();
    } catch (error) {
      showErrorToast(t("networkPanel.startFailed"), {
        description: translateBackendError(t, error),
      });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await invoke("stop_network_capture", { profileId });
      setCapturing(false);
      reset();
    } catch (error) {
      showErrorToast(t("networkPanel.stopFailed"), {
        description: translateBackendError(t, error),
      });
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    const after = lastId.current;
    reset();
    clearedAfter.current = after;
  };

  if (selected !== null && detail) {
    const { host } = splitUrl(detail.url);
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="subtle"
            size="sm"
            onClick={() => {
              setSelected(null);
              setDetail(null);
            }}
          >
            <ArrowLeft aria-hidden className="size-3.5" />
            {t("networkPanel.backToList")}
          </Button>
        </div>
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-sm">
            <span className="font-mono font-medium">{detail.method}</span>
            <span className={cn("font-mono", statusClass(detail))}>
              {detail.status ?? t(`networkPanel.states.${detail.state}`)}
              {detail.status_text ? ` ${detail.status_text}` : ""}
            </span>
            <span className="truncate text-muted-foreground">{host}</span>
          </p>
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {detail.url}
          </p>
          <p className="text-xs text-muted-foreground">
            {[
              detail.type,
              detail.protocol,
              detail.mime,
              formatBytes(detail.bytes),
              formatMs(detail.ms),
              detail.from_cache ? t("networkPanel.fromCache") : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {detail.error && (
            <p className="text-xs text-destructive">{detail.error}</p>
          )}
        </div>
        <Headers
          title={t("networkPanel.requestHeaders")}
          headers={detail.request_headers}
        />
        <Headers
          title={t("networkPanel.responseHeaders")}
          headers={detail.response_headers}
        />
        {detail.post_data && (
          <section className="flex flex-col gap-1">
            <h4 className="text-xs font-medium text-foreground">
              {t("networkPanel.requestBody")}
            </h4>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-foreground/5 px-2.5 py-1.5 font-mono text-[11px]">
              {detail.post_data}
              {detail.post_data_truncated ? "…" : ""}
            </pre>
          </section>
        )}
        <p className="text-[11px] text-muted-foreground">
          {t("networkPanel.redactedNote")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {capturing ? (
          <Button
            type="button"
            variant="soft"
            size="sm"
            onClick={() => void stop()}
            disabled={busy}
          >
            <Square aria-hidden className="size-3.5" />
            {t("networkPanel.stop")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="soft"
            size="sm"
            onClick={() => void start()}
            disabled={busy || !running}
          >
            <Circle aria-hidden className="size-3.5" />
            {t("networkPanel.start")}
          </Button>
        )}
        {capturing && (
          <>
            <Button
              type="button"
              variant="subtle"
              size="sm"
              onClick={clear}
              disabled={requests.length === 0}
            >
              <Eraser aria-hidden className="size-3.5" />
              {t("common.buttons.clear")}
            </Button>
            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Radio aria-hidden className="size-3.5 text-success" />
              {t("networkPanel.capturing", { count: requests.length })}
            </span>
          </>
        )}
      </div>

      {!capturing ? (
        <div className="rounded-lg bg-foreground/5 px-4 py-8 text-center">
          <p className="text-sm text-foreground">
            {running
              ? t("networkPanel.emptyStopped")
              : t("networkPanel.emptyNotRunning")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("networkPanel.privacyNote")}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-col rounded-lg bg-foreground/5">
          <div
            className={cn(
              GRID,
              "border-b border-border/60 px-3 py-1.5 text-[11px] font-medium text-muted-foreground",
            )}
          >
            <span>{t("networkPanel.columns.method")}</span>
            <span>{t("networkPanel.columns.status")}</span>
            <span>{t("networkPanel.columns.host")}</span>
            <span>{t("networkPanel.columns.path")}</span>
            <span>{t("networkPanel.columns.type")}</span>
            <span className="text-right">{t("networkPanel.columns.size")}</span>
            <span className="text-right">{t("networkPanel.columns.time")}</span>
          </div>
          <div
            ref={scrollRef}
            onScroll={() => {
              const element = scrollRef.current;
              if (!element) return;
              stickToEnd.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                STICK_DISTANCE_PX;
            }}
            className="h-72 overflow-y-auto overflow-x-hidden py-1"
          >
            {requests.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t("networkPanel.waiting")}
              </p>
            ) : (
              requests.map((request, index) => {
                const { host, path } = splitUrl(request.url);
                const animate =
                  motionAllowed &&
                  fresh.has(request.id) &&
                  index >= requests.length - ANIMATED_TAIL;
                return (
                  <motion.div
                    key={request.id}
                    initial={animate ? { opacity: 0.6, y: 6 } : false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: MOTION_DURATION.base,
                      ease: MOTION_EASE_OUT,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setSelected(request.id)}
                      aria-label={t("networkPanel.openRequest", {
                        method: request.method,
                        url: request.url,
                      })}
                      className={cn(
                        GRID,
                        "w-full rounded-md px-3 py-0.5 text-left font-mono text-[11px] hover:bg-foreground/5",
                        FOCUS_RING,
                        "focus-visible:ring-offset-0",
                      )}
                    >
                      <span className="truncate font-medium">
                        {request.method}
                      </span>
                      <span className={cn("truncate", statusClass(request))}>
                        {request.status ??
                          t(`networkPanel.states.${request.state}`)}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {host}
                      </span>
                      <span className="truncate" title={path}>
                        {path}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {request.type}
                      </span>
                      <span className="truncate text-right tabular-nums text-muted-foreground">
                        {formatBytes(request.bytes)}
                      </span>
                      <span className="truncate text-right tabular-nums text-muted-foreground">
                        {formatMs(request.ms)}
                      </span>
                    </button>
                  </motion.div>
                );
              })
            )}
          </div>
          {withheld > 0 && (
            <p className="border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
              {t("networkPanel.withheld", { count: withheld })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
