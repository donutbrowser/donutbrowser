import * as React from "react";
import { useTranslation } from "react-i18next";
import { LiveFrame, LiveLine } from "@/components/agent-chat/live-view";
import { StateDot, statusLabelKey } from "@/components/agent-tasks/parts";
import {
  type AgentActivityStore,
  type AgentRowState,
  type AgentSource,
  isLive,
  readResult,
  resultLine,
} from "@/components/profile-table/agent-activity";
import {
  useAgentIntro,
  useAgentRow,
} from "@/components/profile-table/use-agent-activity";
import { Button } from "@/components/ui/button";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useProfilePreviews } from "@/hooks/use-profile-previews";
import { showProfileWindow } from "@/lib/agent-console";
import { hostOf, isTaskMoving, STATE_TEXT, taskState } from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { tipAnchor } from "@/lib/coach-mark";
import { formatTimeAgo } from "@/lib/relative-time";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { BrowserProfile } from "@/types";

type T = ReturnType<typeof useTranslation>["t"];

/** The words a row shows: what it does now, else how it ended. */
export function agentRowLine(t: T, state: AgentRowState): string {
  if (state.status === "needs_approval") return t("agent.tasks.needsYou");
  if (state.status === "done" && state.result) return resultLine(state.result);
  if (state.error && taskState(state.status) === "failed") {
    return translateBackendError(t, state.error);
  }
  if (state.step && state.status !== "queued") return state.step;
  return t(statusLabelKey(state.status));
}

/** The answer laid out: its first table row as names and values, then text. */
export function ResultBody({ text }: { text: string }) {
  const { fields, lines } = readResult(text);
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      {fields.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {fields.map(([name, value]) => (
            <React.Fragment key={name}>
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="truncate">{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {lines.length > 0 && (
        <p className="line-clamp-6 leading-relaxed text-pretty text-muted-foreground">
          {lines.join(" ")}
        </p>
      )}
    </div>
  );
}

/** What the popover of a row shows: the live window, or how it ended. */
function AgentPeek({
  profile,
  state,
  onOpen,
  onAsk,
}: {
  profile: BrowserProfile;
  state: AgentRowState;
  onOpen: () => void;
  onAsk: () => void;
}) {
  const { t, i18n } = useTranslation();
  const live = isLive(state.status);
  const previews = useProfilePreviews(live ? [profile.id] : [], live);
  const host = hostOf(state.url);
  const [now] = React.useState(() => Math.floor(Date.now() / 1000));
  const line = agentRowLine(t, state);
  return (
    <div data-slot="profile-agent-peek" className="flex flex-col gap-3">
      {live && (
        <button
          type="button"
          aria-label={t("commandPalette.actions.showWindow", {
            name: profile.name,
          })}
          onClick={() => {
            void showProfileWindow(profile.id).catch((error: unknown) => {
              showErrorToast(translateBackendError(t, error));
            });
          }}
          className={cn("block w-full cursor-pointer rounded-lg", FOCUS_RING)}
        >
          <LiveFrame
            image={previews[profile.id]?.image}
            className="aspect-[16/10] w-full rounded-lg"
          />
        </button>
      )}
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <StateDot
          status={state.status}
          className={cn(
            "size-1.5",
            isTaskMoving(state.status) &&
              "animate-pulse motion-reduce:animate-none",
          )}
        />
        <span className="shrink-0 font-medium">
          {t(statusLabelKey(state.status))}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          {live
            ? (host ?? "")
            : formatTimeAgo(Math.floor(state.at / 1000), now, i18n.language)}
        </span>
      </div>
      {live ? (
        <LiveLine text={line} className="text-xs text-muted-foreground" />
      ) : state.status === "done" && state.result ? (
        <ResultBody text={state.result} />
      ) : (
        <p className="text-xs text-muted-foreground">{line}</p>
      )}
      <div className="flex justify-end gap-1.5">
        {!live && (
          <Button
            type="button"
            variant="subtle"
            size="sm"
            data-slot="profile-agent-ask"
            className="h-7 rounded-lg text-xs"
            onClick={onAsk}
          >
            {t("profileTable.menu.askAgent")}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          data-slot="profile-agent-open"
          className="h-7 rounded-lg text-xs"
          onClick={onOpen}
        >
          {state.source.kind === "chat"
            ? t("profileTable.agent.openChat")
            : t("profileTable.agent.openRun")}
        </Button>
      </div>
    </div>
  );
}

/**
 * A profile's agent, in one quiet line: what it does now while it works,
 * else how it last ended. The cell opens a look at the live window or the
 * answer; an empty one offers to ask the agent, on hover.
 */
export const AgentCell = React.memo(function AgentCell({
  profile,
  store,
  onOpen,
  onAsk,
}: {
  profile: BrowserProfile;
  store: AgentActivityStore;
  onOpen: (source: AgentSource, profile: BrowserProfile) => void;
  onAsk: (profile: BrowserProfile) => void;
}) {
  const { t } = useTranslation();
  const state = useAgentRow(store, profile.id);
  const intro = useAgentIntro(store, profile.id);
  const [open, setOpen] = React.useState(false);
  const anchor = intro ? tipAnchor("agent-intro") : {};

  if (!state) {
    return (
      <button
        type="button"
        data-slot="profile-agent-cell"
        data-state="none"
        {...anchor}
        onClick={() => onAsk(profile)}
        className={cn(
          !intro && "row-reveal",
          "flex h-6 w-full min-w-0 cursor-pointer items-center rounded-md px-2 text-left text-xs text-muted-foreground transition-colors duration-100 hover:bg-foreground/8 hover:text-foreground",
          FOCUS_RING,
        )}
      >
        <span className="truncate">{t("profileTable.agent.ask")}</span>
      </button>
    );
  }

  const tone = taskState(state.status);
  const line = agentRowLine(t, state);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="profile-agent-cell"
          data-state={tone}
          data-status={state.status}
          {...anchor}
          aria-label={t("profileTable.agent.aria", {
            name: profile.name,
            status: line,
          })}
          className={cn(
            "flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-xs transition-colors duration-100 hover:bg-foreground/8",
            FOCUS_RING,
          )}
        >
          <StateDot
            status={state.status}
            className={cn(
              "size-1.5",
              isTaskMoving(state.status) &&
                "animate-pulse motion-reduce:animate-none",
            )}
          />
          {isLive(state.status) ? (
            <LiveLine
              text={line}
              className={cn("min-w-0 flex-1", STATE_TEXT[tone])}
            />
          ) : (
            <span
              data-slot="profile-agent-line"
              className={cn("min-w-0 flex-1 truncate", STATE_TEXT[tone])}
            >
              {line}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-72 p-3">
        {open && (
          <AgentPeek
            profile={profile}
            state={state}
            onOpen={() => {
              setOpen(false);
              onOpen(state.source, profile);
            }}
            onAsk={() => {
              setOpen(false);
              onAsk(profile);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
});
