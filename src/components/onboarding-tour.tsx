"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  CoachMark,
  CoachMarkBody,
  CoachMarkFooter,
  CoachMarkHeader,
} from "@/components/ui/coach-mark";
import { COACH_MARK_EXIT_MS } from "@/lib/coach-mark";

/**
 * The first-run tour: once the first profile exists, one coach mark on its
 * Launch button. "Got it", Escape or a launch ends it.
 */
export function OnboardingTour({
  open,
  onDone,
}: {
  open: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(
      () => setMounted(false),
      COACH_MARK_EXIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!mounted) return null;

  return (
    <CoachMark
      open={open}
      anchors={["row-launch"]}
      spotlight
      onDismiss={onDone}
      onAnchorActivate={onDone}
      announcement={t("onboarding.launch.title")}
      data-slot="onboarding-tour"
    >
      <CoachMarkHeader title={t("onboarding.launch.title")} />
      <CoachMarkBody>{t("onboarding.launch.content")}</CoachMarkBody>
      <CoachMarkFooter className="justify-end">
        <Button
          type="button"
          size="sm"
          data-slot="onboarding-tour-done"
          disabled={!open}
          onClick={onDone}
        >
          {t("tips.coach.gotIt")}
        </Button>
      </CoachMarkFooter>
    </CoachMark>
  );
}
