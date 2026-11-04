"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { Button } from "@/components/ui/button";
import { useAgentChatSync } from "@/hooks/use-agent-chat";
import { eraseSyncedAgentChats } from "@/lib/agent-chat";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast } from "@/lib/toast-utils";

/**
 * Shown while the account's synced chats stay closed to this device: until
 * a computer that has them opens Donut, or the person erases them.
 */
export function ChatSyncLock() {
  const { t } = useTranslation();
  const { sync } = useAgentChatSync();
  const [confirming, setConfirming] = useState(false);
  const [erasing, setErasing] = useState(false);

  if (!sync.locked) return null;

  const erase = async () => {
    setErasing(true);
    try {
      await eraseSyncedAgentChats();
      setConfirming(false);
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setErasing(false);
    }
  };

  return (
    <div
      data-slot="chat-sync-locked"
      className="mb-1.5 flex shrink-0 flex-col items-start gap-1 rounded-xl bg-foreground/5 px-2.5 py-2"
    >
      <p className="text-[11px] leading-4 text-muted-foreground">
        {t("agent.chat.sync.locked")}
      </p>
      <Button
        type="button"
        variant="link"
        data-slot="chat-sync-erase"
        onClick={() => {
          setConfirming(true);
        }}
        className="h-auto p-0 text-[11px]"
      >
        {t("agent.chat.sync.erase")}
      </Button>
      <DeleteConfirmationDialog
        isOpen={confirming}
        onClose={() => {
          setConfirming(false);
        }}
        onConfirm={erase}
        title={t("agent.chat.sync.eraseTitle")}
        description={t("agent.chat.sync.eraseBody")}
        confirmButtonText={t("agent.chat.sync.eraseConfirm")}
        isLoading={erasing}
      />
    </div>
  );
}
