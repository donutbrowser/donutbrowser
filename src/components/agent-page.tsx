"use client";

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuLogIn } from "react-icons/lu";
import {
  type AgentView,
  AgentWorkspace,
  type ChatSeed,
} from "@/components/agent-chat/workspace";
import { SetupPanel } from "@/components/agent-console-parts";
import { AgentShell } from "@/components/agent-shell";
import {
  ConnectedAgentsNav,
  ConnectedAgentsPane,
  type ConsoleTab,
  useConnectedAgents,
} from "@/components/connected-agents";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SoftFields } from "@/components/ui/field-variant";
import type { AgentConsole } from "@/hooks/use-agent-console";
import type { AgentAvailability } from "@/hooks/use-agent-tasks";
import { canUseScheduledAutomation } from "@/lib/entitlements";
import type { BrowserProfile, CloudUser } from "@/types";

export type { AgentView };

interface AgentPageProps {
  isOpen: boolean;
  onClose: () => void;
  subPage?: boolean;
  /** The view asked for; null leaves the page on its default. */
  initialView: AgentView | null;
  /** Reports the person's own moves, so Mod+J toggles from where they are. */
  onViewChange?: (view: AgentView) => void;
  profiles: BrowserProfile[];
  cloudUser: CloudUser | null;
  agentConsole: AgentConsole;
  /** Opens Integrations on its remote tab. */
  onConnectAgent: () => void;
  onOpenAccount: () => void;
  agent: AgentAvailability;
  /**
   * Opens a new chat, from a profile's menu or the command palette, or a run
   * on the profiles table selection.
   */
  chatSeed: ChatSeed | null;
}

/**
 * The agent page. With the agent: chats first, and connected agents from the
 * sidebar. Without it: the console of agents connected over remote control.
 */
export function AgentPage({
  isOpen,
  onClose,
  subPage,
  initialView,
  onViewChange,
  profiles,
  cloudUser,
  agentConsole,
  onConnectAgent,
  onOpenAccount,
  agent,
  chatSeed,
}: AgentPageProps) {
  const { t } = useTranslation();
  const fallback: AgentView = agent.entitled ? "chat" : "conversation";
  const asked = initialView ?? fallback;
  const [view, setView] = useState<AgentView>(asked);
  const [adopted, setAdopted] = useState(asked);
  if (adopted !== asked) {
    setAdopted(asked);
    setView(asked);
  }
  // Only an account with the agent has chats to show.
  const shownView: AgentView =
    view === "chat" && !agent.entitled ? "conversation" : view;
  const changeView = useCallback(
    (next: AgentView) => {
      setView(next);
      onViewChange?.(next);
    },
    [onViewChange],
  );
  const consoleState = useConnectedAgents({
    enabled: isOpen && cloudUser !== null,
    cloudUser,
    agentConsole,
  });

  const body = () => {
    if (!cloudUser) {
      return (
        <SetupPanel
          testId="agent-setup-signed-out"
          icon={<LuLogIn />}
          title={t("agent.setup.signedOutTitle")}
          body={t("agent.setup.signedOutBody")}
        >
          <Button
            size="sm"
            className="h-8 rounded-lg text-xs"
            data-testid="agent-setup-sign-in"
            onClick={onOpenAccount}
          >
            {t("agent.setup.signedOutAction")}
          </Button>
        </SetupPanel>
      );
    }
    if (agent.entitled) {
      return (
        <AgentWorkspace
          enabled={isOpen}
          view={shownView}
          onViewChange={changeView}
          profiles={profiles}
          agentConsole={agentConsole}
          consoleState={consoleState}
          canSchedule={canUseScheduledAutomation(cloudUser)}
          seed={chatSeed}
          onConnectAgent={onConnectAgent}
          onOpenAccount={onOpenAccount}
        />
      );
    }
    const tab = shownView as ConsoleTab;
    return (
      <AgentShell
        label={t("agent.console.title")}
        sidebar={
          <ConnectedAgentsNav
            tab={tab}
            onTab={changeView}
            state={consoleState}
            agentConsole={agentConsole}
            onConnectAgent={onConnectAgent}
          />
        }
      >
        <ConnectedAgentsPane
          tab={tab}
          onTab={changeView}
          state={consoleState}
          agentConsole={agentConsole}
          profiles={profiles}
          onConnectAgent={onConnectAgent}
          onOpenAccount={onOpenAccount}
        />
      </AgentShell>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose} subPage={subPage}>
      <DialogContent className="flex h-[85vh] max-w-[min(80rem,calc(100%-4rem))] flex-col">
        {!subPage && (
          <DialogTitle className="sr-only">{t("rail.agent")}</DialogTitle>
        )}
        <SoftFields>
          <div
            data-testid="agent-page"
            data-view={shownView}
            className="flex min-h-0 w-full flex-1 flex-col"
          >
            {body()}
          </div>
        </SoftFields>
      </DialogContent>
    </Dialog>
  );
}
