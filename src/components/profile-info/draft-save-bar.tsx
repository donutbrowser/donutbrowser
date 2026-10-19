"use client";

import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { LoadingButton } from "@/components/loading-button";
import { Button } from "@/components/ui/button";
import { ConfirmationMark } from "@/components/ui/confirmation-mark";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_DURATION, MOTION_EASE_OUT, MOTION_SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

const SAVED_FOR_MS = 2000;

/** A short "Saved" state after a save, the same for every field of the panel. */
export function useSavedFlash() {
  const [saved, setSaved] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  const flash = React.useCallback(() => {
    setSaved(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaved(false), SAVED_FOR_MS);
  }, []);
  const clear = React.useCallback(() => {
    window.clearTimeout(timer.current);
    setSaved(false);
  }, []);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  return { saved, flash, clear };
}

/** The confirmation a field that saves on change shows after it saved. */
export function SavedNote({
  saved,
  className,
}: {
  saved: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      role="status"
      data-slot="profile-info-saved"
      data-saved={saved || undefined}
      className={cn(
        "inline-flex min-h-4 items-center gap-1 text-[11px] text-success-text",
        className,
      )}
    >
      {saved && (
        <>
          <ConfirmationMark />
          {t("common.buttons.saved")}
        </>
      )}
    </span>
  );
}

/** A section title with the section's save confirmation at its end. */
export function SectionHeader({
  icon,
  title,
  saved = false,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  saved?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        <h3>{title}</h3>
        <SavedNote saved={saved} />
      </div>
      {children}
    </div>
  );
}

/**
 * The save bar of every section that keeps a draft. It rises while there is
 * something to save and says "Saved" for a moment after a save.
 */
export function DraftSaveBar({
  dirty,
  saving,
  saved,
  error,
  canSave = true,
  disabled = false,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  error?: string | null;
  canSave?: boolean;
  disabled?: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  const motionAllowed = useMotionAllowed();
  const shown = dirty || saving || saved || Boolean(error);

  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {shown && (
        <motion.div
          key="draft-save-bar"
          data-slot="profile-info-save-bar"
          data-dirty={dirty || undefined}
          initial={motionAllowed ? { y: 8 } : false}
          animate={{ y: 0 }}
          exit={
            motionAllowed
              ? {
                  y: 8,
                  opacity: 0,
                  transition: {
                    duration: MOTION_DURATION.fast,
                    ease: MOTION_EASE_OUT,
                  },
                }
              : { opacity: 0, transition: { duration: 0 } }
          }
          transition={motionAllowed ? MOTION_SPRING.snappy : { duration: 0 }}
          className="sticky bottom-0 z-10 -mx-1 mt-1 bg-card pt-2 pb-0.5"
        >
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl py-1.5 pr-1.5 pl-3 text-xs transition-[background-color,box-shadow] duration-200",
              dirty
                ? "bg-primary/8 ring-1 ring-primary/20"
                : "bg-foreground/4 ring-1 ring-transparent",
            )}
          >
            {error ? (
              <p
                role="alert"
                className="min-w-0 flex-1 break-words text-destructive-text"
              >
                {error}
              </p>
            ) : (
              <p
                role="status"
                className={cn(
                  "flex min-h-5 min-w-0 flex-1 items-center gap-2",
                  dirty
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {dirty || saving ? (
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full bg-primary"
                  />
                ) : (
                  <ConfirmationMark />
                )}
                {saving
                  ? t("common.buttons.saving")
                  : dirty
                    ? t("profileInfo.drafts.unsaved")
                    : t("common.buttons.saved")}
              </p>
            )}
            {(dirty || saving) && (
              <div className="ml-auto flex items-center gap-1.5">
                <Button
                  variant="subtle"
                  size="sm"
                  className="h-7 text-xs"
                  data-slot="profile-info-discard"
                  disabled={saving}
                  onClick={onDiscard}
                >
                  {t("appFeedback.discardChanges")}
                </Button>
                <LoadingButton
                  size="sm"
                  className="h-7 text-xs"
                  data-slot="profile-info-save"
                  isLoading={saving}
                  disabled={!dirty || !canSave || disabled}
                  onClick={onSave}
                >
                  {t("common.buttons.save")}
                </LoadingButton>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
