"use client";

import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { LuChevronUp, LuCornerDownRight } from "react-icons/lu";
import { LoadingButton } from "@/components/loading-button";
import { useSettingsMotion } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { ConfirmationMark } from "@/components/ui/confirmation-mark";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface PendingChange {
  label: string;
  section: string;
}

/**
 * The page's save state. It tints when there is something to save, and the
 * review list jumps to the section of each change.
 */
export function SettingsSaveBar({
  pendingChanges,
  isLoading,
  isSaving,
  saved,
  saveError,
  onSave,
  onDiscard,
  onJump,
  onCancel,
}: {
  pendingChanges: PendingChange[];
  isLoading: boolean;
  isSaving: boolean;
  saved: boolean;
  saveError: string | null;
  onSave: () => void;
  onDiscard: () => void;
  onJump: (section: string) => void;
  /** Shown instead of Discard when Settings is a modal. */
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const animate = useSettingsMotion();
  const count = pendingChanges.length;
  const hasChanges = count > 0;

  const status = isLoading
    ? t("common.buttons.loading")
    : isSaving
      ? t("common.buttons.saving")
      : hasChanges
        ? t("appFeedback.pendingChanges", { count })
        : saved
          ? t("common.buttons.saved")
          : t("appFeedback.noChanges");

  return (
    <div
      data-slot="settings-feedback"
      data-pending={hasChanges}
      className="mx-auto w-full max-w-4xl shrink-0 pt-3"
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl py-2 pr-2 pl-3.5 text-xs transition-[background-color,box-shadow] duration-200",
          hasChanges
            ? "bg-primary/8 ring-1 ring-primary/20"
            : "bg-foreground/3 ring-1 ring-transparent",
        )}
      >
        {saveError ? (
          <p
            role="alert"
            className="min-w-0 flex-1 break-words text-destructive-text"
          >
            {saveError}
          </p>
        ) : (
          <p
            role="status"
            className={cn(
              "flex min-h-5 items-center gap-2",
              hasChanges
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            {hasChanges ? (
              <motion.span
                key={count}
                aria-hidden="true"
                initial={animate ? { scale: 2.2 } : false}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 18 }}
                className="size-1.5 rounded-full bg-primary"
              />
            ) : (
              saved && <ConfirmationMark />
            )}
            {status}
          </p>
        )}

        {hasChanges && !saveError && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="subtle"
                size="sm"
                data-slot="settings-review"
                className="h-7 gap-1 px-2 text-xs"
              >
                {t("appFeedback.reviewChanges")}
                <LuChevronUp className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              sideOffset={8}
              className="w-72 p-1.5"
            >
              <ul
                data-slot="settings-review-list"
                className="flex max-h-60 flex-col overflow-y-auto"
              >
                {pendingChanges.map((change) => (
                  <li key={change.label}>
                    <button
                      type="button"
                      onClick={() => onJump(change.section)}
                      className="group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-foreground/6 focus-visible:bg-foreground/6"
                    >
                      <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                      <span className="min-w-0 flex-1 truncate">
                        {change.label}
                      </span>
                      <LuCornerDownRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                    </button>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {onCancel ? (
            <Button variant="subtle" size="sm" onClick={onCancel}>
              {t("common.buttons.cancel")}
            </Button>
          ) : (
            <Button
              variant="subtle"
              size="sm"
              data-slot="settings-discard"
              onClick={onDiscard}
              disabled={!hasChanges || isSaving}
            >
              {t("appFeedback.discardChanges")}
            </Button>
          )}
          <LoadingButton
            size="sm"
            className="h-8"
            data-slot="settings-save"
            isLoading={isSaving}
            onClick={onSave}
            disabled={isLoading || !hasChanges}
          >
            {t("common.buttons.saveSettings")}
          </LoadingButton>
        </div>
      </div>
    </div>
  );
}
