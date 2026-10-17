"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronLeft, LuChevronRight, LuX } from "react-icons/lu";
import { TipScene } from "@/components/tips/scene-for";
import { SCENE_GRID_CLASS } from "@/components/tips/scene-primitives";
import { TipIcon } from "@/components/tips/tip-icon";
import { AnimatedSwitch } from "@/components/ui/animated-switch";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { Label } from "@/components/ui/label";
import { SECTION_LABEL_CLASS } from "@/components/ui/settings-panel";
import { StepTransition } from "@/components/ui/step-transition";
import { useInputModality } from "@/hooks/use-input-modality";
import { MOTION_EASE_OUT, MOTION_SPRING_POSITION } from "@/lib/motion";
import { isMacOS } from "@/lib/platform";
import {
  TIP_SECTIONS,
  type TipAction,
  type TipDefinition,
  type TipId,
  tipTextKeys,
} from "@/lib/tips";
import { cn } from "@/lib/utils";

interface TipsDialogProps {
  open: boolean;
  tips: TipDefinition[];
  seen: string[];
  initialTipId: TipId | null;
  autoShow: boolean;
  onOpenChange: (open: boolean) => void;
  onTipShown: (id: TipId) => void;
  onAutoShowChange: (enabled: boolean) => void;
  onAction: (action: TipAction) => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

/**
 * The tips catalog: every tip this plan may see, grouped by section, with
 * the ones not read yet marked. Each tip is a drawing of the feature at
 * work, a few lines on what it does, and a button into the place it lives.
 * The arrows page in either direction and the drawing travels the same way.
 */
export function TipsDialog({
  open,
  tips,
  seen,
  initialTipId,
  autoShow,
  onOpenChange,
  onTipShown,
  onAutoShowChange,
  onAction,
}: TipsDialogProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const modality = useInputModality();
  const animate = !reduceMotion && modality === "pointer";
  const listId = useId();
  const autoShowId = useId();
  const total = tips.length;
  const initialIndex = Math.max(
    0,
    initialTipId ? tips.findIndex((tip) => tip.id === initialTipId) : 0,
  );
  const [index, setIndex] = useState(initialIndex);
  const [direction, setDirection] = useState<1 | -1>(1);
  const tip = tips[Math.min(index, Math.max(0, total - 1))];
  const mod = isMacOS() ? "⌘" : "Ctrl";
  const listRef = useRef<HTMLElement>(null);
  const advanceRef = useRef<HTMLButtonElement>(null);

  // Each tip is reported once as it comes on screen, so the catalog can tell
  // read from new and the inline tip never repeats it.
  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !tip || reportedRef.current === tip.id) return;
    reportedRef.current = tip.id;
    onTipShown(tip.id);
  }, [open, tip, onTipShown]);

  // The current entry stays in view, also when the catalog opens on a tip
  // far down the list.
  const currentId = tip?.id;
  useEffect(() => {
    if (!open || !currentId) return;
    listRef.current
      ?.querySelector(`[data-tip-id="${currentId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, currentId]);

  if (!tip) return null;

  const keys = tipTextKeys(tip.id);
  const last = index >= total - 1;
  const readCount = tips.filter(
    (item) => seen.includes(item.id) || item.id === tip.id,
  ).length;
  const go = (next: number, focusList = false) => {
    const clamped = Math.max(0, Math.min(total - 1, next));
    if (clamped === index) return;
    setDirection(clamped > index ? 1 : -1);
    setIndex(clamped);
    if (focusList) {
      listRef.current
        ?.querySelector<HTMLButtonElement>(
          `[data-tip-id="${tips[clamped].id}"]`,
        )
        ?.focus();
    }
  };

  const sections = TIP_SECTIONS.map((section) => ({
    section,
    entries: tips
      .map((item, itemIndex) => ({ item, itemIndex }))
      .filter(({ item }) => item.section === section),
  })).filter(({ entries }) => entries.length > 0);

  const moveInList = (event: KeyboardEvent<HTMLElement>) => {
    const step = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[
      event.key
    ];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    go(index + step, true);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="tips-dialog"
        hideClose
        className="h-[min(36rem,calc(100vh-3rem))] gap-0 overflow-hidden p-0 sm:max-w-3xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          advanceRef.current?.focus();
        }}
        onKeyDown={(event) => {
          if (isTypingTarget(event.target)) return;
          if (event.key === "ArrowRight") {
            event.preventDefault();
            go(index + 1);
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            go(index - 1);
          }
        }}
      >
        <div className="grid h-full min-h-0 sm:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="hidden min-h-0 flex-col border-r border-foreground/6 bg-foreground/[0.025] sm:flex">
            <div className="flex flex-col gap-2.5 px-4 pt-5 pb-3">
              <h2 className="text-sm font-semibold tracking-tight">
                {t("tips.title")}
              </h2>
              <div className="flex flex-col gap-1.5">
                <div
                  aria-hidden="true"
                  className="h-1 overflow-hidden rounded-full bg-foreground/8"
                >
                  <div
                    data-slot="tips-progress"
                    className="h-full origin-left rounded-full bg-primary transition-transform duration-300 ease-[var(--ease-out)] motion-reduce:transition-none"
                    style={{ transform: `scaleX(${readCount / total})` }}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {t("tips.progress", { read: readCount, total })}
                </p>
              </div>
            </div>
            <FadingScrollArea className="min-h-0 flex-1 px-2 pb-3">
              <nav
                ref={listRef}
                aria-label={t("tips.title")}
                onKeyDown={moveInList}
              >
                {sections.map(({ section, entries }) => (
                  <div key={section} data-slot="tips-section">
                    <p className={cn(SECTION_LABEL_CLASS, "px-2 pt-3 pb-1.5")}>
                      {t(`tips.sections.${section}`)}
                    </p>
                    <ul data-slot="tips-list" className="flex flex-col gap-px">
                      {entries.map(({ item, itemIndex }) => {
                        const active = itemIndex === index;
                        const read = seen.includes(item.id);
                        return (
                          <li key={item.id}>
                            <button
                              type="button"
                              data-slot="tips-list-item"
                              data-tip-id={item.id}
                              data-seen={read}
                              aria-current={active ? "true" : undefined}
                              tabIndex={active ? 0 : -1}
                              onClick={() => go(itemIndex)}
                              className={cn(
                                "relative isolate flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] outline-none transition-colors duration-150",
                                "focus-visible:ring-2 focus-visible:ring-ring",
                                active
                                  ? "text-foreground"
                                  : "text-muted-foreground hover:text-foreground",
                              )}
                            >
                              {active && (
                                <motion.span
                                  aria-hidden="true"
                                  data-slot="tips-list-indicator"
                                  layoutId={
                                    animate ? `${listId}-indicator` : undefined
                                  }
                                  initial={false}
                                  transition={
                                    animate
                                      ? MOTION_SPRING_POSITION
                                      : { duration: 0 }
                                  }
                                  className="absolute inset-0 -z-10 rounded-lg bg-foreground/6"
                                />
                              )}
                              <span
                                className={cn(
                                  "grid size-6 shrink-0 place-items-center rounded-md transition-colors duration-200 [&_svg]:size-3.5",
                                  active
                                    ? "bg-primary/12 text-primary-text"
                                    : "bg-foreground/5",
                                )}
                              >
                                <TipIcon id={item.id} />
                              </span>
                              <span className="min-w-0 flex-1 truncate">
                                {t(tipTextKeys(item.id).label)}
                              </span>
                              {!read && !active && (
                                <span
                                  role="img"
                                  aria-label={t("tips.unread")}
                                  data-slot="tips-unread-dot"
                                  className="size-1.5 shrink-0 rounded-full bg-primary"
                                />
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </nav>
            </FadingScrollArea>
            <div className="flex items-center gap-2.5 border-t border-foreground/6 px-4 py-3">
              <AnimatedSwitch
                id={autoShowId}
                data-slot="tips-auto-show"
                checked={autoShow}
                onCheckedChange={onAutoShowChange}
              />
              <Label
                htmlFor={autoShowId}
                className="cursor-pointer text-xs leading-snug font-normal text-muted-foreground"
              >
                {t("tips.autoShow")}
              </Label>
            </div>
          </aside>

          <section
            data-slot="tip-detail"
            data-tip-id={tip.id}
            className="flex min-h-0 min-w-0 flex-col overflow-y-auto"
          >
            <div className="px-5 pt-5">
              <div
                data-slot="tip-scene-panel"
                className={cn(
                  "relative aspect-[2/1] max-h-64 w-full overflow-hidden rounded-xl bg-foreground/[0.025] ring-1 ring-foreground/6 ring-inset",
                  SCENE_GRID_CLASS,
                )}
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.div
                    key={tip.id}
                    className="absolute inset-0 p-4"
                    initial={animate ? { x: direction * 40 } : false}
                    animate={{ x: 0, opacity: 1 }}
                    exit={
                      animate
                        ? { x: -direction * 40, opacity: 0 }
                        : { opacity: 0, transition: { duration: 0 } }
                    }
                    transition={{ duration: 0.26, ease: MOTION_EASE_OUT }}
                  >
                    <TipScene id={tip.id} />
                  </motion.div>
                </AnimatePresence>
                <DialogClose
                  aria-label={t("common.buttons.close")}
                  className="absolute top-2.5 right-2.5 grid size-7 cursor-pointer place-items-center rounded-full bg-background/80 text-muted-foreground ring-1 ring-foreground/8 backdrop-blur-sm transition-[color,transform] duration-150 ease-[var(--ease-out)] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-95 motion-reduce:active:scale-100"
                >
                  <LuX className="size-3.5" />
                </DialogClose>
              </div>
            </div>

            <StepTransition
              transitionKey={tip.id}
              direction={direction}
              className="flex flex-col gap-2 px-6 pt-5"
            >
              <p
                className={cn(
                  SECTION_LABEL_CLASS,
                  "flex items-center gap-1.5 [&_svg]:size-3",
                )}
              >
                <TipIcon id={tip.id} />
                {t(`tips.sections.${tip.section}`)}
              </p>
              <DialogTitle className="text-xl leading-tight font-semibold tracking-tight text-balance">
                {t(keys.title, { mod })}
              </DialogTitle>
              <p className="max-w-[58ch] text-sm/6 text-pretty text-muted-foreground">
                {t(keys.body, { mod })}
              </p>
            </StepTransition>

            <div className="mt-auto flex flex-wrap items-center justify-between gap-3 px-5 pt-6 pb-5">
              <div className="flex items-center gap-0.5">
                <Button
                  type="button"
                  variant="subtle"
                  size="icon"
                  className="size-8"
                  aria-label={t("tips.previous")}
                  data-slot="tip-previous"
                  disabled={index === 0}
                  onClick={() => go(index - 1)}
                >
                  <LuChevronLeft className="size-4" />
                </Button>
                <span
                  className="min-w-[6ch] text-center text-xs text-muted-foreground tabular-nums"
                  aria-live="polite"
                >
                  {t("tips.count", { current: index + 1, total })}
                </span>
                <Button
                  type="button"
                  variant="subtle"
                  size="icon"
                  className="size-8"
                  aria-label={t("tips.next")}
                  data-slot="tip-next"
                  disabled={last}
                  onClick={() => go(index + 1)}
                >
                  <LuChevronRight className="size-4" />
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="soft"
                  size="sm"
                  data-slot="tip-action"
                  onClick={() => onAction(tip.action)}
                >
                  {t(keys.action)}
                </Button>
                <Button
                  ref={advanceRef}
                  type="button"
                  size="sm"
                  data-slot="tip-advance"
                  onClick={() => {
                    if (last) onOpenChange(false);
                    else go(index + 1);
                  }}
                >
                  {t(last ? "tips.done" : "tips.nextShort")}
                </Button>
              </div>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
