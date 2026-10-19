"use client";

import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { LuPlay, LuSquare } from "react-icons/lu";
import { RippleButton } from "@/components/ui/ripple";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type LaunchStage,
  useLaunchActivity,
} from "@/hooks/use-launch-activity";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_EASE_OUT, MOTION_SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** How far the ring fills at each launch stage. */
const STAGE_PROGRESS: Record<LaunchStage, number> = {
  queued: 0.1,
  preparing: 0.25,
  network: 0.35,
  extensions: 0.45,
  starting: 0.6,
  running: 0.9,
  failed: 0,
};

const RING_SPRING = { type: "spring" as const, stiffness: 300, damping: 30 };
const RING_RADIUS = 12.5;

/**
 * The launch control's tooltip. While a launch is in flight it opens by
 * itself and names the stage the backend is in, so a multi-second launch
 * reads as progress rather than a bare ring. It is click-through for that
 * time, so it can never sit between the pointer and a neighbouring row.
 */
function LaunchControlTooltip({
  stage,
  launching,
  content,
  children,
}: {
  stage: LaunchStage | undefined;
  launching: boolean;
  content: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const live =
    launching &&
    stage !== undefined &&
    stage !== "running" &&
    stage !== "failed";
  return (
    <Tooltip open={live ? true : undefined}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {(live || content) && (
        <TooltipContent
          data-launch-stage={live ? stage : undefined}
          className={cn(live && "pointer-events-none")}
        >
          {live ? t(`appFeedback.launch.${stage}`) : content}
        </TooltipContent>
      )}
    </Tooltip>
  );
}

/**
 * The ring that stands in for a spinner. It fills as the backend reports
 * launch stages and drains when the browser stops. Before the first stage
 * arrives it turns, so a launch never looks frozen.
 */
function LaunchRing({
  progress,
  draining,
  turning,
  animate,
}: {
  progress: number;
  draining: boolean;
  turning: boolean;
  animate: boolean;
}) {
  return (
    <motion.svg
      aria-hidden="true"
      viewBox="0 0 28 28"
      className="size-7"
      initial={{ rotate: 0 }}
      animate={{ rotate: turning && animate ? 360 : 0 }}
      transition={
        turning && animate
          ? { duration: 1.2, ease: "linear", repeat: Number.POSITIVE_INFINITY }
          : { duration: 0 }
      }
    >
      <g transform="rotate(-90 14 14)">
        <circle
          cx={14}
          cy={14}
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="opacity-20"
        />
        <motion.circle
          cx={14}
          cy={14}
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          initial={animate ? { pathLength: draining ? 1 : 0 } : false}
          animate={{ pathLength: progress }}
          transition={
            !animate
              ? { duration: 0 }
              : draining
                ? { duration: 0.2, ease: MOTION_EASE_OUT }
                : RING_SPRING
          }
        />
      </g>
    </motion.svg>
  );
}

export interface LaunchControlProps {
  profileId: string;
  profileName: string;
  isRunning: boolean;
  isLaunching: boolean;
  isStopping: boolean;
  canLaunch: boolean;
  /** A synchronizer follower keeps the neutral look while it runs. */
  isFollower: boolean;
  tooltip: React.ReactNode;
  onLaunch: () => void;
  onStop: () => void;
}

/**
 * Launch and stop, the row's core action. The play, ring and stop marks
 * cross-fade; the ring fills by launch stage; a profile that comes up gives
 * one ping.
 */
export function LaunchControl({
  profileId,
  profileName,
  isRunning,
  isLaunching,
  isStopping,
  canLaunch,
  isFollower,
  tooltip,
  onLaunch,
  onStop,
}: LaunchControlProps) {
  const { t } = useTranslation();
  const motionAllowed = useMotionAllowed();
  const stage = useLaunchActivity(profileId).at(-1)?.stage;
  const busy = isLaunching || isStopping;
  const mark = busy ? "ring" : isRunning ? "stop" : "play";

  const wasRunning = React.useRef(isRunning);
  const [ping, setPing] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (isRunning && !wasRunning.current && motionAllowed) setPing(Date.now());
    wasRunning.current = isRunning;
  }, [isRunning, motionAllowed]);

  const progress = isStopping
    ? 0
    : stage === undefined
      ? 0.12
      : STAGE_PROGRESS[stage];

  const icon =
    mark === "ring" ? (
      <LaunchRing
        progress={progress}
        draining={isStopping}
        turning={isLaunching && stage === undefined}
        animate={motionAllowed}
      />
    ) : mark === "stop" ? (
      <LuSquare className="size-3 fill-current" />
    ) : (
      <LuPlay className="size-3 translate-x-px fill-current" />
    );

  return (
    <LaunchControlTooltip
      stage={stage}
      launching={isLaunching}
      content={tooltip}
    >
      <span className="relative inline-flex">
        {ping !== null && (
          <motion.span
            key={ping}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full bg-success"
            initial={{ scale: 1, opacity: 0.4 }}
            animate={{ scale: 1.5, opacity: 0 }}
            transition={{ duration: 0.5, ease: MOTION_EASE_OUT }}
            onAnimationComplete={() => setPing(null)}
          />
        )}
        <RippleButton
          variant="soft"
          size="sm"
          data-running={isRunning ? "true" : undefined}
          data-launch-control={profileId}
          disabled={!canLaunch || busy}
          aria-label={
            isRunning
              ? t("profileTable.aria.stop", { name: profileName })
              : t("profileTable.aria.launch", { name: profileName })
          }
          aria-busy={busy || undefined}
          className={cn(
            "grid size-7 place-items-center rounded-full p-0 transition-[background-color,color,transform] duration-150",
            !canLaunch && "cursor-not-allowed opacity-50",
            canLaunch && "cursor-pointer",
            !isRunning &&
              !busy &&
              "hover:bg-primary hover:text-primary-foreground",
            isRunning &&
              !isFollower &&
              "bg-destructive/12 text-destructive-text hover:bg-destructive/20",
          )}
          onClick={() => (isRunning ? onStop() : onLaunch())}
        >
          <span className="relative grid size-7 place-items-center">
            {motionAllowed ? (
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={mark}
                  className="grid place-items-center"
                  initial={{ scale: 0.6, opacity: 0.5 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  transition={{ duration: 0.16, ease: MOTION_EASE_OUT }}
                >
                  {icon}
                </motion.span>
              </AnimatePresence>
            ) : (
              <span className="grid place-items-center">{icon}</span>
            )}
          </span>
        </RippleButton>
      </span>
    </LaunchControlTooltip>
  );
}

/** The steady dot by a running profile's name. */
export function LiveDot() {
  const { t } = useTranslation();
  const motionAllowed = useMotionAllowed();
  return (
    <span className="inline-flex shrink-0 items-center">
      <motion.span
        aria-hidden="true"
        data-slot="profile-live-dot"
        className="size-1.5 rounded-full bg-success"
        initial={motionAllowed ? { scale: 0 } : false}
        animate={{ scale: 1 }}
        transition={MOTION_SPRING.snappy}
      />
      <span className="sr-only">{t("common.status.running")}</span>
    </span>
  );
}
