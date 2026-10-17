"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuEllipsis } from "react-icons/lu";
import type { AppPage } from "@/components/rail-nav";
import { TipScene } from "@/components/tips/scene-for";
import { ScenePlayback } from "@/components/tips/scene-primitives";
import { TipIcon } from "@/components/tips/tip-icon";
import { Button } from "@/components/ui/button";
import {
  CoachMark,
  CoachMarkBody,
  CoachMarkFooter,
  CoachMarkHeader,
  CoachMarkScene,
} from "@/components/ui/coach-mark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TipsFlow } from "@/hooks/use-tips";
import { isMacOS } from "@/lib/platform";
import { formatShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { actionStaysOn, type TipAction, tipTextKeys } from "@/lib/tips";
import { showSuccessToast } from "@/lib/toast-utils";

/** Tips introduced this session; coming back to the page does not replay the entrance. */
const introduced = new Set<string>();
/** The drawing plays this long, then rests until the pointer comes over it. */
const SCENE_PLAY_MS = 12_000;

function tipsShortcut(): string {
  const shortcut = SHORTCUTS.find((item) => item.id === "openTips");
  return shortcut ? formatShortcut(shortcut).join(isMacOS() ? "" : "+") : "";
}

/**
 * The day's tip, pointed out on the feature itself: a coach mark on the
 * column, button or rail item where the feature lives. When the feature is on
 * another page, the mark sits on the rail item that leads there and its
 * button goes straight to it. Using the feature, "Got it" and Escape all
 * close the tip as read; the next one waits for tomorrow.
 *
 * The same mark shows a tip picked in the catalog with "Show me".
 */
export function TipCoachMark({
  flow,
  page,
  onAction,
}: {
  flow: TipsFlow;
  page: AppPage;
  onAction: (action: TipAction) => void;
}) {
  const { t } = useTranslation();
  const current = flow.pageTip;
  const id = current?.tip.id;
  // Read before the effect below records the tip, so only a return visit
  // comes in settled.
  const settled = useMemo(() => (id ? introduced.has(id) : false), [id]);
  const [intro, setIntro] = useState(true);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!id) return;
    const first = !introduced.has(id);
    introduced.add(id);
    setIntro(first);
    if (!first) return;
    const timer = window.setTimeout(() => setIntro(false), SCENE_PLAY_MS);
    return () => window.clearTimeout(timer);
  }, [id]);

  if (!current || page !== "profiles") return null;
  const { tip, leaving, preview } = current;
  const keys = tipTextKeys(tip.id);
  const mod = isMacOS() ? "⌘" : "Ctrl";
  const title = t(keys.title, { mod });
  const showAction = !actionStaysOn(tip.action, page);

  return (
    <CoachMark
      key={`${tip.id}:${preview}`}
      open={!leaving}
      anchors={tip.anchors}
      settled={settled}
      onDismiss={flow.dismissPageTip}
      onAnchorActivate={flow.dismissPageTip}
      announcement={t("tips.coach.announce", { title })}
      data-slot="tip-coach-mark"
      data-tip-id={tip.id}
      data-preview={preview}
    >
      <div
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <CoachMarkScene>
          <ScenePlayback playing={!leaving && (intro || hovered)}>
            <div className="absolute inset-0 p-2">
              <TipScene id={tip.id} />
            </div>
          </ScenePlayback>
        </CoachMarkScene>
        <CoachMarkHeader
          eyebrow={
            <>
              <span className="grid size-4 place-items-center text-primary-text [&_svg]:size-3">
                <TipIcon id={tip.id} />
              </span>
              <span className="text-primary-text">
                {t("tips.coach.eyebrow")}
              </span>
              <span aria-hidden="true">·</span>
              <span className="truncate">
                {t(`tips.sections.${tip.section}`)}
              </span>
            </>
          }
          title={title}
          aside={
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="subtle"
                  size="icon"
                  className="-mt-1 -mr-2 size-7"
                  aria-label={t("tips.coach.more")}
                  data-slot="tip-coach-menu"
                  disabled={leaving}
                >
                  <LuEllipsis className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  data-slot="tip-coach-all"
                  onSelect={() => flow.openTips(tip.id)}
                >
                  {t("tips.coach.allTips")}
                </DropdownMenuItem>
                {!preview && (
                  <DropdownMenuItem
                    data-slot="tip-coach-off"
                    onSelect={() => {
                      // Off takes the tip away unread; the flow sees the
                      // switch and lets the mark go.
                      void flow.setAutoShow(false).then((saved) => {
                        if (!saved) return;
                        showSuccessToast(t("tips.coach.offTitle"), {
                          description: t("tips.coach.offBody", {
                            shortcut: tipsShortcut(),
                          }),
                          sound: null,
                        });
                      });
                    }}
                  >
                    {t("tips.coach.turnOff")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        <CoachMarkBody>{t(keys.body, { mod })}</CoachMarkBody>
        <CoachMarkFooter className="justify-end">
          <Button
            type="button"
            size="sm"
            variant={showAction ? "subtle" : "soft"}
            data-slot="tip-coach-dismiss"
            disabled={leaving}
            onClick={flow.dismissPageTip}
          >
            {t("tips.coach.gotIt")}
          </Button>
          {showAction && (
            <Button
              type="button"
              size="sm"
              data-slot="tip-coach-action"
              disabled={leaving}
              onClick={() => {
                flow.dismissPageTip();
                onAction(tip.action);
              }}
            >
              {t(keys.action)}
            </Button>
          )}
        </CoachMarkFooter>
      </div>
    </CoachMark>
  );
}
