"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LuAppWindow } from "react-icons/lu";
import { StateDot } from "@/components/agent-tasks/parts";
import { Button } from "@/components/ui/button";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { showProfileWindow } from "@/lib/agent-console";
import { type AgentTaskStatus, hostOf, isTaskMoving } from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";

/** A line that crossfades when its text changes, in place. */
export function LiveLine({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const animate = useMotionAllowed();
  return (
    <span className={cn("relative block h-4 overflow-hidden", className)}>
      <AnimatePresence initial={false}>
        <motion.span
          key={text}
          initial={animate ? { opacity: 0, y: 3 } : false}
          animate={{ opacity: 1, y: 0 }}
          exit={animate ? { opacity: 0, y: -3 } : { opacity: 0 }}
          transition={
            animate
              ? { duration: MOTION_DURATION.slow, ease: MOTION_EASE_OUT }
              : { duration: 0 }
          }
          className="absolute inset-0 truncate leading-4"
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** The picture of a profile's window, or a quiet mark until one comes. */
export function LiveFrame({
  image,
  mark,
  className,
}: {
  image: string | undefined;
  /** What shows in place of a picture; a window icon by default. */
  mark?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative grid place-items-center overflow-hidden bg-foreground/5",
        className,
      )}
    >
      {image ? (
        // biome-ignore lint/performance/noImgElement: base64 data URI previews cannot use next/image
        <img
          src={image}
          alt=""
          className="absolute inset-1 size-[calc(100%-0.5rem)] rounded-lg object-cover object-top"
        />
      ) : (
        (mark ?? (
          <LuAppWindow
            className="size-5 text-muted-foreground"
            aria-hidden="true"
          />
        ))
      )}
    </span>
  );
}

function useShowWindow(profileId: string) {
  const { t } = useTranslation();
  return () => {
    void showProfileWindow(profileId).catch((error: unknown) => {
      showErrorToast(translateBackendError(t, error));
    });
  };
}

/**
 * The profile's browser while the agent works in it: its window, live, with
 * what the agent does now laid over it. A click brings the window forward.
 * `strip` is the short form a narrow pane shows above the thread.
 */
export function LiveView({
  profileId,
  profileName,
  status,
  step,
  url,
  image,
  layout,
}: {
  profileId: string;
  profileName: string;
  status: AgentTaskStatus;
  /** What the agent does now, in words. */
  step: string;
  url: string | null;
  image: string | undefined;
  layout: "panel" | "strip";
}) {
  const { t } = useTranslation();
  const show = useShowWindow(profileId);
  const host = hostOf(url);
  const label = t("commandPalette.actions.showWindow", { name: profileName });

  if (layout === "strip") {
    return (
      <button
        type="button"
        data-slot="agent-live-strip"
        data-profile-id={profileId}
        aria-label={label}
        title={label}
        onClick={show}
        className={cn(
          "flex w-full shrink-0 cursor-pointer items-center gap-3 rounded-2xl bg-foreground/5 p-1.5 pr-3 text-left transition-colors duration-150 hover:bg-foreground/8 motion-reduce:transition-none",
          FOCUS_RING,
        )}
      >
        <LiveFrame image={image} className="h-11 w-18 shrink-0 rounded-xl" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <LiveLine text={step} className="text-xs" />
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <StateDot
              status={status}
              className={cn(
                "size-1.5",
                isTaskMoving(status) &&
                  "animate-pulse motion-reduce:animate-none",
              )}
            />
            <span className="truncate">{host ?? profileName}</span>
          </span>
        </span>
      </button>
    );
  }

  return (
    <section
      data-slot="agent-live-view"
      data-profile-id={profileId}
      aria-label={t("agent.live.label", { name: profileName })}
      className="flex min-h-0 flex-col gap-2"
    >
      <header className="flex min-h-8 items-center gap-2 pl-1">
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {host ?? profileName}
        </span>
        <Button
          type="button"
          variant="subtle"
          size="sm"
          data-slot="agent-live-show"
          onClick={show}
          className="ml-auto h-7 shrink-0 gap-1.5 rounded-lg px-2 text-xs text-muted-foreground"
        >
          <LuAppWindow className="size-3.5" aria-hidden="true" />
          {t("agent.actions.showWindow")}
        </Button>
      </header>
      <button
        type="button"
        aria-label={label}
        onClick={show}
        className={cn(
          "group relative block w-full cursor-pointer overflow-hidden rounded-2xl",
          FOCUS_RING,
        )}
      >
        <LiveFrame image={image} className="aspect-[16/10] w-full" />
        <span className="absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-xl bg-background/92 px-3 py-2 text-left shadow-sm">
          <StateDot
            status={status}
            className={cn(
              "size-1.5",
              isTaskMoving(status) &&
                "animate-pulse motion-reduce:animate-none",
            )}
          />
          <LiveLine text={step} className="min-w-0 flex-1 text-xs" />
        </span>
      </button>
    </section>
  );
}
