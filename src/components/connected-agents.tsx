"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuActivity,
  LuArrowLeft,
  LuCalendarClock,
  LuHourglass,
  LuLock,
  LuMessagesSquare,
  LuPause,
  LuPlay,
  LuPlug,
  LuPower,
  LuScrollText,
  LuUsers,
} from "react-icons/lu";
import { AgentActivityFeed } from "@/components/agent-activity";
import {
  SetupPanel,
  useNow,
  useTimeFormat,
} from "@/components/agent-console-parts";
import {
  AgentConversation,
  NeedsYouList,
} from "@/components/agent-conversation";
import { AgentProfiles } from "@/components/agent-profiles";
import { AgentRecipes } from "@/components/agent-recipes";
import { AgentSchedules } from "@/components/agent-schedules";
import {
  SidebarSection,
  SidebarToggle,
  sidebarRow,
  useAgentShell,
} from "@/components/agent-shell";
import { PaneHeader } from "@/components/agent-tasks/parts";
import { AnimatedSwitch } from "@/components/ui/animated-switch";
import { Button } from "@/components/ui/button";
import { CodeSnippet } from "@/components/ui/code-snippet";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { ProBadge } from "@/components/ui/pro-badge";
import { Textarea } from "@/components/ui/textarea";
import type { AgentConsole } from "@/hooks/use-agent-console";
import { MAX_TEXT_CHARS, profileRollup, quotaLeft } from "@/lib/agent-console";
import {
  canUseRemoteControl,
  canUseScheduledAutomation,
  getEntitlements,
} from "@/lib/entitlements";
import type { McpRemoteStatus } from "@/lib/mcp";
import { showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { BrowserProfile, CloudUser } from "@/types";

/** The views of the console for agents connected over remote control. */
export const CONSOLE_TABS = [
  "conversation",
  "profiles",
  "activity",
  "recipes",
  "schedules",
] as const;

export type ConsoleTab = (typeof CONSOLE_TABS)[number];

const TAB_ICONS = {
  conversation: LuMessagesSquare,
  profiles: LuUsers,
  activity: LuActivity,
  recipes: LuScrollText,
  schedules: LuCalendarClock,
} as const;

function useRemoteStatus(enabled: boolean) {
  const [remote, setRemote] = useState<McpRemoteStatus | null>(null);
  const [known, setKnown] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    invoke<McpRemoteStatus>("get_mcp_remote_status")
      .then((status) => {
        if (!cancelled) setRemote(status);
      })
      .catch((error: unknown) => {
        console.warn("Failed to get MCP remote status:", error);
      })
      .finally(() => {
        if (!cancelled) setKnown(true);
      });
    const unlisten = listen<McpRemoteStatus>("mcp-remote-status", (event) => {
      setRemote(event.payload);
      setKnown(true);
    });
    return () => {
      cancelled = true;
      void unlisten.then((off) => {
        off();
      });
    };
  }, [enabled]);

  return { remote, known };
}

/**
 * What the console keeps while the page is open: the plan's limits, remote
 * control, and the conversation's chosen agent and profile.
 */
export function useConnectedAgents({
  enabled,
  cloudUser,
  agentConsole,
}: {
  enabled: boolean;
  cloudUser: CloudUser | null;
  agentConsole: AgentConsole;
}) {
  const now = useNow();
  const { remote, known: remoteKnown } = useRemoteStatus(enabled);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [composerProfileId, setComposerProfileId] = useState<string | null>(
    null,
  );
  const [focusComposer, setFocusComposer] = useState(false);
  const onComposerFocused = useCallback(() => {
    setFocusComposer(false);
  }, []);

  const signedIn = cloudUser !== null;
  const blocker: "signedOut" | "plan" | null = !signedIn
    ? "signedOut"
    : !canUseRemoteControl(cloudUser)
      ? "plan"
      : null;

  const effectiveSessionId =
    selectedSessionId !== null &&
    agentConsole.sessions.some(
      (session) => session.session_id === selectedSessionId,
    )
      ? selectedSessionId
      : null;

  const preferredProfileIds = useMemo(
    () =>
      profileRollup(agentConsole.activity, agentConsole.holds, now).map(
        (row) => row.profile_id,
      ),
    [agentConsole.activity, agentConsole.holds, now],
  );

  return {
    now,
    remote,
    remoteKnown,
    blocker,
    automation: getEntitlements(cloudUser).browserAutomation,
    // Solo keeps recipes for the schedules it pays for, without on-demand runs.
    scheduled: canUseScheduledAutomation(cloudUser),
    sessionId: effectiveSessionId,
    setSessionId: setSelectedSessionId,
    composerProfileId,
    setComposerProfileId,
    focusComposer,
    setFocusComposer,
    onComposerFocused,
    preferredProfileIds,
  };
}

export type ConnectedAgentsState = ReturnType<typeof useConnectedAgents>;

function PauseControl({ agentConsole }: { agentConsole: AgentConsole }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const switchId = useId();
  const noteId = useId();
  const paused = agentConsole.paused !== null;

  const pause = async () => {
    setBusy(true);
    const trimmed = note.trim();
    const ok = await agentConsole.setPaused(true, trimmed || null);
    setBusy(false);
    if (ok) {
      setOpen(false);
      setNote("");
      showSuccessToast(t("agent.pause.pausedToast"));
    }
  };

  const resume = async () => {
    setBusy(true);
    const ok = await agentConsole.setPaused(false, null);
    setBusy(false);
    if (ok) showSuccessToast(t("agent.pause.resumedToast"));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="flex h-9 items-center gap-2.5 px-2.5">
          <AnimatedSwitch
            id={switchId}
            checked={paused || open}
            disabled={busy}
            data-testid="agent-pause-switch"
            onCheckedChange={(checked) => {
              if (checked) setOpen(true);
              else if (paused) void resume();
              else setOpen(false);
            }}
          />
          <Label htmlFor={switchId} className="text-sm font-normal">
            {t("agent.pause.label")}
          </Label>
        </div>
      </PopoverAnchor>
      <PopoverContent side="top" align="start" className="w-72 p-3">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void pause();
          }}
        >
          <Label
            htmlFor={noteId}
            className="text-xs font-medium text-muted-foreground"
          >
            {t("agent.pause.noteLabel")}
          </Label>
          <Textarea
            id={noteId}
            variant="soft"
            rows={3}
            value={note}
            maxLength={MAX_TEXT_CHARS}
            placeholder={t("agent.pause.notePlaceholder")}
            className="min-h-16 resize-none text-sm"
            data-testid="agent-pause-note"
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
          <p className="text-[11px] text-muted-foreground">
            {t("agent.pause.explain")}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="subtle"
              size="sm"
              className="h-8 rounded-lg text-xs"
              onClick={() => {
                setOpen(false);
              }}
            >
              {t("common.buttons.cancel")}
            </Button>
            <Button
              type="submit"
              size="sm"
              className="h-8 rounded-lg text-xs"
              disabled={busy}
              aria-busy={busy}
              data-testid="agent-pause-confirm"
            >
              {t("agent.pause.confirm")}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function PausedBanner({ agentConsole }: { agentConsole: AgentConsole }) {
  const { t } = useTranslation();
  const { shortClock } = useTimeFormat();
  const [busy, setBusy] = useState(false);
  const paused = agentConsole.paused;
  if (!paused) return null;
  return (
    <div
      role="status"
      data-testid="agent-paused-banner"
      className="flex shrink-0 flex-wrap items-center gap-3 rounded-2xl bg-warning/10 px-3.5 py-2.5 text-sm text-warning-text"
    >
      <LuPause className="size-4 shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">
          {t("agent.pause.banner", { time: shortClock(paused.since) })}
        </span>
        {paused.note && (
          <span className="truncate text-xs">
            {t("agent.pause.bannerNote", { note: paused.note })}
          </span>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        variant="soft"
        className="h-8 gap-1.5 rounded-lg text-xs"
        disabled={busy}
        aria-busy={busy}
        data-testid="agent-resume"
        onClick={async () => {
          setBusy(true);
          const ok = await agentConsole.setPaused(false, null);
          setBusy(false);
          if (ok) showSuccessToast(t("agent.pause.resumedToast"));
        }}
      >
        <LuPlay className="size-3.5" aria-hidden="true" />
        {t("agent.pause.resume")}
      </Button>
    </div>
  );
}

/**
 * The console's sidebar: its views, then the limit, the pause and the way to
 * connect another agent. `onBack` leads back to the chats.
 */
export function ConnectedAgentsNav({
  tab,
  onTab,
  onBack,
  state,
  agentConsole,
  onConnectAgent,
}: {
  tab: ConsoleTab;
  onTab: (tab: ConsoleTab) => void;
  onBack?: () => void;
  state: ConnectedAgentsState;
  agentConsole: AgentConsole;
  onConnectAgent: () => void;
}) {
  const { t } = useTranslation();
  const { closeSidebar } = useAgentShell();
  const quota = quotaLeft(agentConsole.quota);
  const needsYou = agentConsole.openRequests.length;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {onBack && (
        <button
          type="button"
          data-slot="agent-console-back"
          onClick={() => {
            onBack();
            closeSidebar();
          }}
          className={sidebarRow(false, "h-9 shrink-0 font-medium")}
        >
          <LuArrowLeft className="size-4 shrink-0" aria-hidden="true" />
          {t("agent.console.back")}
        </button>
      )}
      <FadingScrollArea className="-mx-1 min-h-0 flex-1 px-1">
        {state.blocker === null && (
          <SidebarSection label={onBack ? t("agent.console.title") : undefined}>
            {CONSOLE_TABS.map((item) => {
              const Icon = TAB_ICONS[item];
              const selected = item === tab;
              return (
                <li key={item}>
                  <button
                    type="button"
                    data-testid={`agent-tab-${item}`}
                    data-state={selected ? "active" : "inactive"}
                    aria-current={selected ? "page" : undefined}
                    onClick={() => {
                      onTab(item);
                      closeSidebar();
                    }}
                    className={sidebarRow(selected, "h-9")}
                  >
                    <Icon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {t(`agent.tabs.${item}`)}
                    </span>
                    {item === "conversation" && needsYou > 0 && (
                      <span className="rounded-full bg-warning/15 px-1.5 text-xs tabular-nums text-warning-text">
                        {needsYou}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </SidebarSection>
        )}
      </FadingScrollArea>
      {state.blocker === null && (
        <div className="flex shrink-0 flex-col gap-1">
          {quota && (
            <span
              data-testid="agent-quota"
              className={cn(
                "px-2.5 pb-1 text-xs tabular-nums",
                quota.left === 0
                  ? "text-warning-text"
                  : "text-muted-foreground",
              )}
            >
              {t("agent.header.quota", {
                left: quota.left,
                limit: quota.limit,
              })}
            </span>
          )}
          <PauseControl agentConsole={agentConsole} />
          <Button
            type="button"
            variant="soft"
            size="sm"
            data-testid="agent-connect"
            onClick={onConnectAgent}
            className="h-9 justify-start gap-2.5 rounded-xl px-2.5 text-sm font-normal"
          >
            <LuPlug className="size-3.5" aria-hidden="true" />
            {t("agent.header.connect")}
          </Button>
        </div>
      )}
    </div>
  );
}

function PlanPanel({
  testId,
  title,
  body,
  onOpenAccount,
}: {
  testId: string;
  title: string;
  body: string;
  onOpenAccount: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SetupPanel testId={testId} icon={<LuLock />} title={title} body={body}>
      <div className="flex items-center gap-2">
        <ProBadge />
        <Button
          size="sm"
          variant="soft"
          className="h-8 rounded-lg text-xs"
          data-testid={`${testId}-account`}
          onClick={onOpenAccount}
        >
          {t("agent.setup.planAction")}
        </Button>
      </div>
    </SetupPanel>
  );
}

/** The console's main pane: the view chosen in its sidebar. */
export function ConnectedAgentsPane({
  tab,
  onTab,
  state,
  agentConsole,
  profiles,
  onConnectAgent,
  onOpenAccount,
}: {
  tab: ConsoleTab;
  onTab: (tab: ConsoleTab) => void;
  state: ConnectedAgentsState;
  agentConsole: AgentConsole;
  profiles: BrowserProfile[];
  onConnectAgent: () => void;
  onOpenAccount: () => void;
}) {
  const { t } = useTranslation();
  const profileNames = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.name])),
    [profiles],
  );
  const { now, remote, remoteKnown, blocker } = state;
  const remoteOff = remoteKnown && remote !== null && !remote.enabled;
  const hasSessions = agentConsole.sessions.length > 0;

  const openComposerFor = (profileId: string, sessionId: string | null) => {
    state.setComposerProfileId(profileId);
    state.setSessionId(sessionId);
    state.setFocusComposer(true);
    onTab("conversation");
  };

  const body = () => {
    if (blocker === "plan") {
      return (
        <PlanPanel
          testId="agent-setup-plan"
          title={t("agent.setup.planTitle")}
          body={t("agent.setup.planBody")}
          onOpenAccount={onOpenAccount}
        />
      );
    }
    switch (tab) {
      case "conversation": {
        const ready = agentConsole.loaded && remoteKnown;
        const needsYou = agentConsole.openRequests.length > 0 && (
          <NeedsYouList
            agentConsole={agentConsole}
            profileNames={profileNames}
            now={now}
          />
        );
        if (hasSessions) {
          return (
            <AgentConversation
              lead={
                <>
                  {needsYou}
                  {remoteOff && (
                    <div
                      data-testid="agent-setup-remote-off"
                      className="flex shrink-0 flex-wrap items-center gap-3 rounded-2xl bg-foreground/5 px-3.5 py-2.5 text-xs text-muted-foreground"
                    >
                      <LuPower
                        className="size-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        {t("agent.setup.remoteOffInline")}
                      </span>
                      <Button
                        size="sm"
                        variant="soft"
                        className="h-8 rounded-lg text-xs"
                        data-testid="agent-setup-turn-on"
                        onClick={onConnectAgent}
                      >
                        {t("agent.setup.remoteOffAction")}
                      </Button>
                    </div>
                  )}
                </>
              }
              agentConsole={agentConsole}
              profiles={profiles}
              profileNames={profileNames}
              selectedSessionId={state.sessionId}
              onSelectSession={state.setSessionId}
              composerProfileId={state.composerProfileId}
              onComposerProfileChange={state.setComposerProfileId}
              focusComposer={state.focusComposer}
              onComposerFocused={state.onComposerFocused}
              preferredProfileIds={state.preferredProfileIds}
              now={now}
            />
          );
        }
        return (
          <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1">
            {needsYou}
            {!ready ? null : remoteOff ? (
              <SetupPanel
                testId="agent-setup-remote-off"
                icon={<LuPower />}
                title={t("agent.setup.remoteOffTitle")}
                body={t("agent.setup.remoteOffBody")}
              >
                <Button
                  size="sm"
                  className="h-8 rounded-lg text-xs"
                  data-testid="agent-setup-turn-on"
                  onClick={onConnectAgent}
                >
                  {t("agent.setup.remoteOffAction")}
                </Button>
              </SetupPanel>
            ) : (
              <SetupPanel
                testId="agent-setup-waiting"
                icon={<LuHourglass />}
                title={t("agent.setup.waitingTitle")}
                body={t("agent.setup.waitingBody")}
              >
                <div className="flex w-full max-w-xl flex-col gap-2 text-left">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("agent.setup.starterLabel")}
                  </span>
                  <CodeSnippet
                    multiline
                    wrap
                    data-testid="agent-starter-text"
                    code={t("agent.setup.starter")}
                    copyLabel={t("agent.setup.starterLabel")}
                    successMessage={t("agent.setup.starterCopied")}
                    className="font-sans text-xs leading-relaxed"
                  />
                  <Button
                    size="sm"
                    variant="soft"
                    className="mt-1 h-8 gap-1.5 self-center rounded-lg text-xs"
                    data-testid="agent-setup-connect"
                    onClick={onConnectAgent}
                  >
                    <LuPlug className="size-3.5" aria-hidden="true" />
                    {t("agent.header.connect")}
                  </Button>
                </div>
              </SetupPanel>
            )}
          </div>
        );
      }
      case "profiles":
        return (
          <AgentProfiles
            agentConsole={agentConsole}
            profileNames={profileNames}
            now={now}
            onNote={(profileId, sessionId) => {
              openComposerFor(profileId, sessionId);
            }}
          />
        );
      case "activity":
        return (
          <AgentActivityFeed
            agentConsole={agentConsole}
            profileNames={profileNames}
            now={now}
          />
        );
      case "recipes":
        return state.automation || state.scheduled ? (
          <AgentRecipes
            profiles={profiles}
            canRunOnDesktop={state.automation}
            desktopConnected={remote?.connected ?? false}
          />
        ) : (
          <PlanPanel
            testId="agent-recipes-plan"
            title={t("agent.tabs.recipes")}
            body={t("agent.recipes.needsAutomation")}
            onOpenAccount={onOpenAccount}
          />
        );
      case "schedules":
        return state.scheduled ? (
          <AgentSchedules
            profiles={profiles}
            canRunOnDesktop={state.automation}
          />
        ) : (
          <PlanPanel
            testId="agent-schedules-plan"
            title={t("agent.tabs.schedules")}
            body={t("agent.schedules.needsPlan")}
            onOpenAccount={onOpenAccount}
          />
        );
    }
  };

  return (
    <section
      data-slot="agent-console"
      data-tab={tab}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
    >
      <PaneHeader
        lead={<SidebarToggle />}
        title={
          blocker === "plan" ? t("agent.console.title") : t(`agent.tabs.${tab}`)
        }
      />
      {blocker === null && <PausedBanner agentConsole={agentConsole} />}
      <div className="flex min-h-0 flex-1 flex-col">{body()}</div>
    </section>
  );
}
