"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuEllipsis, LuX } from "react-icons/lu";
import type { AppPage } from "@/components/rail-nav";
import { TipScene } from "@/components/tips/scene-for";
import {
  SCENE_GRID_CLASS,
  ScenePlayback,
} from "@/components/tips/scene-primitives";
import { TipIcon } from "@/components/tips/tip-icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { INLINE_TIP_EXIT_MS, type TipsFlow } from "@/hooks/use-tips";
import { MOTION_EASE_OUT } from "@/lib/motion";
import { isMacOS } from "@/lib/platform";
import { formatShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { actionStaysOn, type TipAction, tipTextKeys } from "@/lib/tips";
import { showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";

/** Tips that made their entrance this session; a page switch does not replay it. */
const entered = new Set<string>();
/** The drawing plays this long, then rests until the pointer comes over it. */
const SCENE_PLAY_MS = 12_000;

function tipsShortcut(): string {
  const shortcut = SHORTCUTS.find((item) => item.id === "openTips");
  return shortcut ? formatShortcut(shortcut).join(isMacOS() ? "" : "+") : "";
}

/**
 * The day's tip, as a slim card under the profile table. It takes its own
 * row, so it never covers a profile, and it never takes the focus. It comes
 * in once with a short rise, plays its drawing for a few loops, and leaves
 * when it is dismissed, acted on, or no longer needed.
 */
export function InlineTip({
  flow,
  page,
  onAction,
}: {
  flow: TipsFlow;
  page: AppPage;
  onAction: (action: TipAction) => void;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion() ?? false;
  const current = flow.inlineTip;
  const id = current?.tip.id;
  const [intro, setIntro] = useState(true);
  const [hovered, setHovered] = useState(false);
  const firstEntrance = id !== undefined && !entered.has(id);

  useEffect(() => {
    if (!id) return;
    entered.add(id);
    setIntro(true);
    const timer = window.setTimeout(() => setIntro(false), SCENE_PLAY_MS);
    return () => window.clearTimeout(timer);
  }, [id]);

  if (!current) return null;
  const { tip, leaving } = current;
  const keys = tipTextKeys(tip.id);
  const mod = isMacOS() ? "⌘" : "Ctrl";

  return (
    <motion.aside
      key={tip.id}
      data-slot="inline-tip"
      data-tip-id={tip.id}
      data-state={leaving ? "leaving" : "shown"}
      aria-label={t("tips.inline.label")}
      className="@container mt-2 mb-2.5 shrink-0 [@media(max-height:420px)]:hidden"
      initial={firstEntrance && !reduceMotion ? { y: 14, scale: 0.985 } : false}
      animate={
        leaving
          ? reduceMotion
            ? { opacity: 0 }
            : { y: 8, scale: 0.985, opacity: 0 }
          : { y: 0, scale: 1, opacity: 1 }
      }
      transition={{
        duration: leaving ? (INLINE_TIP_EXIT_MS - 20) / 1000 : 0.42,
        ease: MOTION_EASE_OUT,
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div className="flex items-center gap-3.5 rounded-xl bg-foreground/[0.035] p-2 pr-2.5 ring-1 ring-foreground/5 ring-inset">
        <div
          aria-hidden="true"
          data-slot="inline-tip-scene"
          className={cn(
            "relative hidden h-16 w-32 shrink-0 overflow-hidden rounded-lg bg-background/70 ring-1 ring-foreground/6 @2xl:block",
            "[&_svg_*]:[stroke-width:3.25px] [&_text:not([data-scene-keep])]:hidden",
            SCENE_GRID_CLASS,
          )}
        >
          <ScenePlayback playing={!leaving && (intro || hovered)}>
            <div className="absolute inset-0 p-1.5">
              <TipScene id={tip.id} />
            </div>
          </ScenePlayback>
        </div>
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary-text @2xl:hidden [&_svg]:size-4"
        >
          <TipIcon id={tip.id} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <span className="text-primary-text">
              {t("tips.inline.eyebrow")}
            </span>
            <span aria-hidden="true">·</span>
            <span className="truncate">
              {t(`tips.sections.${tip.section}`)}
            </span>
          </p>
          <p className="truncate text-sm leading-snug font-medium">
            {t(keys.title, { mod })}
          </p>
          <p className="line-clamp-1 text-xs leading-relaxed text-pretty text-muted-foreground @4xl:line-clamp-2">
            {t(keys.body, { mod })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!actionStaysOn(tip.action, page) && (
            <Button
              type="button"
              size="sm"
              variant="soft"
              data-slot="inline-tip-action"
              disabled={leaving}
              onClick={() => {
                flow.dismissInlineTip();
                onAction(tip.action);
              }}
            >
              {t(keys.action)}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="subtle"
                size="icon"
                className="size-8"
                aria-label={t("tips.inline.more")}
                data-slot="inline-tip-menu"
                disabled={leaving}
              >
                <LuEllipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                data-slot="inline-tip-all"
                onSelect={() => flow.openTips(tip.id)}
              >
                {t("tips.inline.allTips")}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-slot="inline-tip-off"
                onSelect={() => {
                  void flow.setAutoShow(false).then((saved) => {
                    if (!saved) return;
                    showSuccessToast(t("tips.inline.offTitle"), {
                      description: t("tips.inline.offBody", {
                        shortcut: tipsShortcut(),
                      }),
                      sound: null,
                    });
                  });
                }}
              >
                {t("tips.inline.turnOff")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant="subtle"
            size="icon"
            className="size-8"
            aria-label={t("tips.inline.dismiss")}
            data-slot="inline-tip-dismiss"
            disabled={leaving}
            onClick={flow.dismissInlineTip}
          >
            <LuX className="size-4" />
          </Button>
        </div>
      </div>
    </motion.aside>
  );
}
