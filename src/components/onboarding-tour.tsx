"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ClipId,
  clipAspect,
  RestingClip,
} from "@/components/feature-clip";
import { Button } from "@/components/ui/button";
import {
  CoachMark,
  CoachMarkBody,
  CoachMarkClip,
  CoachMarkFooter,
  CoachMarkHeader,
} from "@/components/ui/coach-mark";
import { StepDots } from "@/components/ui/step-dots";
import { StepTransition } from "@/components/ui/step-transition";
import { COACH_MARK_EXIT_MS, type CoachAnchorId } from "@/lib/coach-mark";

export type TourStep = 0 | 1;

const STEPS: readonly {
  key: "createProfile" | "dnsBlocking";
  anchors: readonly CoachAnchorId[];
  clip: ClipId;
}[] = [
  { key: "createProfile", anchors: ["new-profile"], clip: "newProfile" },
  {
    key: "dnsBlocking",
    anchors: ["row-dns", "column-dns"],
    clip: "dnsBlocklist",
  },
];

/**
 * The first-run tour: the page dims around one feature at a time and a coach
 * mark explains it. The first step waits for the person to create a profile
 * with the button it points at; the second shows that profile's DNS
 * blocking and finishes. Skip and Escape end it at any step.
 */
export function OnboardingTour({
  open,
  step,
  onSkip,
  onFinish,
}: {
  open: boolean;
  step: TourStep;
  onSkip: () => void;
  onFinish: () => void;
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
  const current = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <CoachMark
      open={open}
      anchors={current.anchors}
      spotlight
      floatWithoutAnchor
      stepKey={step}
      onDismiss={onSkip}
      announcement={t(`onboarding.steps.${current.key}.title`)}
      data-slot="onboarding-tour"
      data-step={step}
    >
      <CoachMarkClip aspect={clipAspect(current.clip)}>
        <RestingClip
          key={step}
          id={current.clip}
          className="absolute inset-0 rounded-[inherit]"
        />
      </CoachMarkClip>
      <StepTransition transitionKey={step} direction={1}>
        <CoachMarkHeader
          eyebrow={t("onboarding.stepOf", {
            current: step + 1,
            total: STEPS.length,
          })}
          title={t(`onboarding.steps.${current.key}.title`)}
        />
        <CoachMarkBody>
          {t(`onboarding.steps.${current.key}.content`)}
        </CoachMarkBody>
      </StepTransition>
      <CoachMarkFooter>
        <StepDots
          count={STEPS.length}
          current={step}
          label={t("onboarding.progress")}
          className="ps-1"
        />
        {last ? (
          <Button
            type="button"
            size="sm"
            data-slot="onboarding-tour-finish"
            disabled={!open}
            onClick={onFinish}
          >
            {t("onboarding.buttons.finish")}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="subtle"
            data-slot="onboarding-tour-skip"
            disabled={!open}
            onClick={onSkip}
          >
            {t("onboarding.buttons.skip")}
          </Button>
        )}
      </CoachMarkFooter>
    </CoachMark>
  );
}
