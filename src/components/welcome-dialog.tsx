"use client";

import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { LuArrowLeft, LuArrowRight, LuLoaderCircle } from "react-icons/lu";
import { RestingClip } from "@/components/feature-clip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { StepDots } from "@/components/ui/step-dots";
import { StepTransition } from "@/components/ui/step-transition";
import { usePermissions } from "@/hooks/use-permissions";

type WelcomeStep = "intro" | "license" | "permissions";

function StepHeading({ title, body }: { title: ReactNode; body: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <h2 className="text-2xl font-semibold text-balance">{title}</h2>
      <p className="mx-auto max-w-[52ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
        {body}
      </p>
    </div>
  );
}

/**
 * The first-run welcome: the intro, the licensing terms and, on macOS while a
 * permission is missing, the microphone and camera request. The browser
 * downloads in the background meanwhile; finishing or skipping hands over to
 * the app.
 *
 * Steps travel, they do not fade in. Onboarding is the first thing a new
 * install shows and the only way past it is the button on the current step,
 * so a step that fails to appear is a dead app. Text and controls are at full
 * opacity from the first frame and only move into place.
 */
export function WelcomeDialog({
  isOpen,
  onComplete,
}: {
  isOpen: boolean;
  /** Finished or skipped: either way the welcome is done. */
  onComplete: () => void;
}) {
  const { t } = useTranslation();
  const {
    requestPermission,
    isMicrophoneAccessGranted,
    isCameraAccessGranted,
    isInitialized,
    requiresSystemPermissions,
  } = usePermissions(isOpen);
  const [step, setStep] = useState<WelcomeStep>("intro");
  const [direction, setDirection] = useState<1 | -1>(1);
  const [requesting, setRequesting] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const permissionsGranted = isMicrophoneAccessGranted && isCameraAccessGranted;
  const showPermissionsStep =
    requiresSystemPermissions &&
    (step === "permissions" || !isInitialized || !permissionsGranted);
  const visibleSteps: WelcomeStep[] = [
    "intro",
    "license",
    ...(showPermissionsStep ? (["permissions"] as const) : []),
  ];
  const currentStepIndex = Math.max(0, visibleSteps.indexOf(step));
  const go = (next: WelcomeStep) => {
    setDirection(visibleSteps.indexOf(next) >= currentStepIndex ? 1 : -1);
    setStep(next);
  };
  const back = () => {
    const previous = visibleSteps[currentStepIndex - 1];
    if (previous) go(previous);
  };

  // Each step starts at its top, and Enter acts on its primary button.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the step is the trigger
  useLayoutEffect(() => {
    document
      .querySelector('[data-slot="welcome-dialog"]')
      ?.scrollTo({ top: 0 });
    if (isOpen) primaryRef.current?.focus({ preventScroll: true });
  }, [step]);

  const requestPermissions = useCallback(async () => {
    setRequesting(true);
    try {
      if (!isMicrophoneAccessGranted) {
        await requestPermission("microphone");
      }
      if (!isCameraAccessGranted) {
        await requestPermission("camera");
      }
    } catch (err) {
      console.error("Permission request failed:", err);
    } finally {
      setRequesting(false);
      onComplete();
    }
  }, [
    isCameraAccessGranted,
    isMicrophoneAccessGranted,
    requestPermission,
    onComplete,
  ]);

  const acceptLicense = () => {
    if (requiresSystemPermissions && !(isInitialized && permissionsGranted)) {
      go("permissions");
    } else {
      onComplete();
    }
  };

  const skipButton = (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground hover:text-foreground"
      disabled={requesting}
      onClick={onComplete}
    >
      {t("welcome.skip")}
    </Button>
  );
  const backButton = (
    <Button
      type="button"
      variant="subtle"
      size="icon"
      className="size-8"
      aria-label={t("common.buttons.back")}
      data-slot="welcome-back"
      disabled={requesting}
      onClick={back}
    >
      <LuArrowLeft className="size-4" />
    </Button>
  );

  let body: ReactNode = null;
  let primary: ReactNode = null;

  switch (step) {
    case "intro":
      body = (
        <StepHeading title={t("welcome.title")} body={t("welcome.tagline")} />
      );
      primary = (
        <Button
          ref={primaryRef}
          size="sm"
          className="gap-1.5"
          onClick={() => go("license")}
        >
          {t("welcome.next")}
          <LuArrowRight className="size-4 shrink-0" />
        </Button>
      );
      break;

    case "license":
      body = (
        <>
          <StepHeading
            title={t("welcome.license.title")}
            body={t("welcome.license.body")}
          />
          <dl className="mx-auto flex max-w-[52ch] flex-col gap-2 text-center text-base/7 text-pretty sm:text-sm/6">
            <div>
              <dt className="font-medium text-foreground">
                {t("welcome.license.personalTitle")}
              </dt>
              <dd className="text-muted-foreground">
                {t("welcome.license.personalDesc")}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">
                {t("welcome.license.commercialTitle")}
              </dt>
              <dd className="text-muted-foreground">
                {t("welcome.license.commercialDesc")}
              </dd>
            </div>
          </dl>
        </>
      );
      primary = (
        <Button
          ref={primaryRef}
          size="sm"
          className="gap-1.5"
          onClick={acceptLicense}
        >
          {t("welcome.license.agree")}
          <LuArrowRight className="size-4 shrink-0" />
        </Button>
      );
      break;

    case "permissions":
      body = (
        <StepHeading
          title={t("welcome.permissions.title")}
          body={t("welcome.permissions.desc")}
        />
      );
      primary = (
        <Button
          ref={primaryRef}
          size="sm"
          className="gap-1.5"
          disabled={requesting}
          onClick={() => {
            void requestPermissions();
          }}
        >
          {requesting && (
            <LuLoaderCircle className="size-4 shrink-0 motion-safe:animate-spin" />
          )}
          {requesting
            ? t("welcome.permissions.requesting")
            : t("welcome.permissions.grant")}
        </Button>
      );
      break;
  }

  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DialogContent
        dismissible={false}
        data-slot="welcome-dialog"
        data-step={step}
        className="gap-0 overflow-x-hidden p-0 sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          primaryRef.current?.focus({ preventScroll: true });
        }}
      >
        <DialogTitle className="sr-only">{t("welcome.title")}</DialogTitle>

        {step === "intro" && (
          <div className="px-3 pt-3 sm:px-4 sm:pt-4 [@media(max-height:540px)]:hidden">
            <div
              data-slot="welcome-clip-panel"
              className="relative mx-auto aspect-[3/1] w-[min(100%,34.5rem,90vh)] overflow-hidden rounded-xl bg-foreground/[0.025]"
            >
              <RestingClip id="welcome" className="size-full rounded-xl" />
            </div>
          </div>
        )}

        <StepTransition
          transitionKey={step}
          direction={direction}
          className="flex flex-col gap-4 px-5 pt-5 sm:px-8 [@media(max-height:540px)]:pt-4"
        >
          {body}
        </StepTransition>

        <div className="sticky bottom-0 z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-3 bg-background px-4 pt-5 pb-4 sm:px-5 sm:pb-5 [@media(max-height:540px)]:pt-4">
          <div className="flex min-w-0 items-center justify-start">
            {skipButton}
          </div>
          <StepDots
            count={visibleSteps.length}
            current={currentStepIndex}
            label={t("welcome.progress")}
          />
          <div className="flex min-w-0 items-center justify-end gap-1.5">
            {step !== "intro" && backButton}
            {primary}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
