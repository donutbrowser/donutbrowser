"use client";

import { useTranslation } from "react-i18next";
import { ChatMarkdown } from "@/components/agent-chat/markdown";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface WhatsNew {
  version: string;
  notes: string;
}

/** The release notes of the version this app was just updated to. */
export function WhatsNewDialog({
  whatsNew,
  onClose,
}: {
  whatsNew: WhatsNew | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={whatsNew !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[80vh] max-w-xl flex-col">
        <DialogHeader>
          <DialogTitle>
            {t("whatsNew.title", { version: whatsNew?.version ?? "" })}
          </DialogTitle>
        </DialogHeader>
        <div
          data-slot="whats-new-notes"
          className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1"
        >
          <ChatMarkdown text={whatsNew?.notes ?? ""} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
