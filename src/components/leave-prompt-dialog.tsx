"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type LeaveChoice, setLeavePrompt } from "@/hooks/use-unsaved-changes";

interface PendingPrompt {
  labels: string[];
  resolve: (choice: LeaveChoice) => void;
}

/**
 * Asks Save, Discard or Stay before a navigation unmounts a page with edits
 * that are not saved. Mounted once by the app shell; `confirmLeave()` opens it.
 */
export function LeavePromptDialog() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const pendingRef = useRef<PendingPrompt | null>(null);
  pendingRef.current = pending;

  useEffect(() => {
    setLeavePrompt(
      (labels) =>
        new Promise<LeaveChoice>((resolve) => {
          // A second navigation while the prompt is open answers the first
          // with Stay, so no caller waits for ever.
          pendingRef.current?.resolve("stay");
          setPending({ labels, resolve });
        }),
    );
    return () => {
      setLeavePrompt(null);
      pendingRef.current?.resolve("stay");
    };
  }, []);

  const answer = (choice: LeaveChoice) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending(null);
    current.resolve(choice);
  };

  const labels = pending?.labels ?? [];

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) answer("stay");
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("leavePrompt.title")}</DialogTitle>
          <DialogDescription>
            {labels.length === 1
              ? t("leavePrompt.descriptionOne", { label: labels[0] })
              : t("leavePrompt.description")}
          </DialogDescription>
        </DialogHeader>
        {labels.length > 1 && (
          <ul className="flex flex-col gap-1 text-sm">
            {labels.map((label) => (
              <li key={label} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                />
                <span className="min-w-0 break-words">{label}</span>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="subtle"
            data-slot="leave-prompt-stay"
            onClick={() => answer("stay")}
          >
            {t("leavePrompt.stay")}
          </Button>
          <Button
            variant="soft"
            data-slot="leave-prompt-discard"
            onClick={() => answer("discard")}
          >
            {t("leavePrompt.discard")}
          </Button>
          <Button
            data-slot="leave-prompt-save"
            autoFocus
            onClick={() => answer("save")}
          >
            {t("leavePrompt.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
