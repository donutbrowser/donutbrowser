"use client";

import { useTranslation } from "react-i18next";
import { SidebarToggle } from "@/components/agent-shell";
import { PaneHeader } from "@/components/agent-tasks/parts";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { useWaitWords } from "@/hooks/use-agent-inbox";
import { chatAge } from "@/lib/agent-chat";
import { type AgentFocus, type AgentWait, focusOf } from "@/lib/agent-inbox";

/** Everything that waits for the person; a row opens its chat or run. */
export function InboxPane({
  waits,
  nameOf,
  onOpen,
}: {
  waits: AgentWait[];
  nameOf: (profileId: string) => string;
  onOpen: (focus: AgentFocus) => void;
}) {
  const { t, i18n } = useTranslation();
  const words = useWaitWords();
  const now = Date.now();
  return (
    <section
      data-slot="agent-inbox"
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
    >
      <PaneHeader lead={<SidebarToggle />} title={t("agent.inbox.title")} />
      <FadingScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-2xl flex-col py-1">
          {waits.length === 0 ? (
            <p
              data-slot="agent-inbox-empty"
              className="px-2 py-6 text-center text-sm text-muted-foreground"
            >
              {t("agent.inbox.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {[...waits].reverse().map((wait) => {
                const age = chatAge(wait.at, now, i18n.language);
                return (
                  <li key={wait.key}>
                    <button
                      type="button"
                      data-slot="agent-inbox-item"
                      data-kind={wait.kind}
                      data-chat-id={wait.chatId ?? undefined}
                      data-batch-id={wait.batchId ?? undefined}
                      onClick={() => {
                        onOpen(focusOf(wait));
                      }}
                      className="flex w-full cursor-pointer flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
                    >
                      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        <span
                          aria-hidden="true"
                          className="size-2 shrink-0 rounded-full bg-warning"
                        />
                        <span className="truncate">
                          {nameOf(wait.profileId)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="min-w-0 truncate">{wait.title}</span>
                        <span className="ml-auto shrink-0 tabular-nums">
                          {age.kind === "now"
                            ? t("agent.chat.justNow")
                            : age.text}
                        </span>
                      </span>
                      <span className="line-clamp-2 pl-4 text-sm leading-5">
                        {words(wait)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </FadingScrollArea>
    </section>
  );
}
