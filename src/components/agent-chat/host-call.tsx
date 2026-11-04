"use client";

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuX } from "react-icons/lu";
import type { PaneSelection } from "@/components/agent-chat/sidebar";
import {
  ProfilePicker,
  useScheduleWords,
} from "@/components/agent-tasks/parts";
import {
  RepeatPicker,
  repeatInvalid,
  repeatOf,
  scheduleOf,
} from "@/components/agent-tasks/repeat-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  answerAgentChatHostCall,
  type ChatTurn,
  type HostCall,
  type HostRequest,
} from "@/lib/agent-chat";
import {
  type AgentBatch,
  localTimezone,
  MAX_PROMPT_CHARS,
} from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { BrowserProfile, GroupWithCount } from "@/types";

/** What a change card needs from the panel around it. */
export interface HostContext {
  /** The profiles the agent works in. */
  profiles: BrowserProfile[];
  groups: GroupWithCount[];
  batches: AgentBatch[];
  canSchedule: boolean;
  onUpgrade: () => void;
  onOpen: (selection: PaneSelection) => void;
}

/** A schedule without a zone runs in the device's. */
function withLocalZone(request: HostRequest): HostRequest {
  if (request.method !== "routines.save" || !request.routine.schedule) {
    return request;
  }
  const { schedule } = request.routine;
  return schedule.timezone
    ? request
    : {
        ...request,
        routine: {
          ...request.routine,
          schedule: { ...schedule, timezone: localTimezone() },
        },
      };
}

/** Without the plan a routine is saved to run by hand. */
function allowed(request: HostRequest, canSchedule: boolean): HostRequest {
  return request.method === "routines.save" && !canSchedule
    ? { ...request, routine: { ...request.routine, schedule: null } }
    : request;
}

function profilesOf(request: HostRequest): string[] {
  switch (request.method) {
    case "routines.save":
      return request.routine.profileIds;
    case "routines.delete":
      return [];
    default:
      return request.profileIds;
  }
}

function titleKey(request: HostRequest): string {
  switch (request.method) {
    case "routines.save":
      return request.id ? "agent.chat.host.edit" : "agent.chat.host.save";
    case "routines.run":
      return "agent.chat.host.run";
    case "routines.delete":
      return "agent.chat.host.delete";
    default:
      return "agent.chat.host.tasks";
  }
}

function useProfileWords(profiles: BrowserProfile[]) {
  const { t } = useTranslation();
  return (ids: string[]) => {
    const names = ids
      .map((id) => profiles.find((profile) => profile.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    return names.length > 0 && names.length <= 3 && names.length === ids.length
      ? names.join(", ")
      : t("agent.tasks.profileCount", { count: ids.length });
  };
}

/** A change the agent asks for, shown before it is done, editable. */
function HostCallCard({
  chatId,
  call,
  host,
}: {
  chatId: string;
  call: HostCall;
  host: HostContext;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const scheduleWords = useScheduleWords();
  const profileWords = useProfileWords(host.profiles);
  const [request, setRequest] = useState(() => withLocalZone(call.request));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const answer = async (approve: boolean) => {
    setBusy(true);
    try {
      await answerAgentChatHostCall(
        chatId,
        call.callId,
        approve ? allowed(request, host.canSchedule) : null,
      );
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setBusy(false);
    }
  };

  const profileIds = profilesOf(request);
  const setProfiles = (ids: string[]) => {
    setRequest((current) =>
      current.method === "routines.save"
        ? { ...current, routine: { ...current.routine, profileIds: ids } }
        : current.method === "routines.delete"
          ? current
          : { ...current, profileIds: ids },
    );
  };
  const routine = request.method === "routines.save" ? request.routine : null;
  const locked = Boolean(routine?.schedule) && !host.canSchedule;
  const prompt =
    routine?.prompt ?? (request.method === "tasks.run" ? request.prompt : null);
  const name =
    routine?.name ??
    (request.method === "routines.run" || request.method === "routines.delete"
      ? request.name
      : null);
  const editable = request.method !== "routines.delete";
  const invalid =
    (request.method !== "routines.delete" && profileIds.length === 0) ||
    (prompt !== null && prompt.trim() === "") ||
    (routine !== null &&
      (routine.name.trim() === "" ||
        repeatInvalid(repeatOf(routine.schedule))));

  const setPrompt = (value: string) => {
    setRequest((current) =>
      current.method === "routines.save"
        ? { ...current, routine: { ...current.routine, prompt: value } }
        : current.method === "tasks.run"
          ? { ...current, prompt: value }
          : current,
    );
  };

  const meta = [
    request.method === "routines.delete" ? null : profileWords(profileIds),
    routine ? scheduleWords(locked ? null : routine.schedule) : null,
    routine && !routine.enabled ? t("agent.chat.routineOff") : null,
  ].filter((part): part is string => part !== null);

  return (
    <section
      data-slot="chat-host-call"
      data-call-id={call.callId}
      data-method={request.method}
      aria-label={t(titleKey(request))}
      className="flex flex-col gap-2.5 rounded-2xl bg-foreground/4 p-3"
    >
      <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
        {t(titleKey(request))}
      </span>
      {editing ? (
        <div className="flex flex-col gap-2">
          {routine && (
            <>
              <Label htmlFor={`${formId}-name`} className="sr-only">
                {t("agent.routines.name")}
              </Label>
              <Input
                id={`${formId}-name`}
                variant="soft"
                value={routine.name}
                maxLength={120}
                data-slot="chat-host-name"
                className="h-8 text-sm md:text-sm"
                onChange={(event) => {
                  const value = event.target.value;
                  setRequest((current) =>
                    current.method === "routines.save"
                      ? {
                          ...current,
                          routine: { ...current.routine, name: value },
                        }
                      : current,
                  );
                }}
              />
            </>
          )}
          {prompt !== null && (
            <>
              <Label htmlFor={`${formId}-prompt`} className="sr-only">
                {t("agent.routines.prompt")}
              </Label>
              <Textarea
                id={`${formId}-prompt`}
                variant="soft"
                rows={2}
                value={prompt}
                maxLength={MAX_PROMPT_CHARS}
                data-slot="chat-host-prompt"
                className="max-h-40 min-h-16 resize-none text-sm field-sizing-content"
                onChange={(event) => {
                  setPrompt(event.target.value);
                }}
              />
            </>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <ProfilePicker
              profiles={host.profiles}
              groups={host.groups}
              selected={profileIds}
              onChange={setProfiles}
              className="rounded-xl"
            />
            {routine && (
              <RepeatPicker
                value={repeatOf(routine.schedule)}
                onChange={(repeat) => {
                  setRequest((current) =>
                    current.method === "routines.save"
                      ? {
                          ...current,
                          routine: {
                            ...current.routine,
                            schedule: scheduleOf(repeat),
                          },
                        }
                      : current,
                  );
                }}
                allowOnce={false}
                canSchedule={host.canSchedule}
                onUpgrade={host.onUpgrade}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {name !== null && (
            <span
              data-slot="chat-host-name-text"
              className="text-sm font-medium break-words"
            >
              {name}
            </span>
          )}
          {prompt !== null && (
            <p className="line-clamp-3 text-sm leading-6 break-words whitespace-pre-wrap text-muted-foreground">
              {prompt}
            </p>
          )}
          {meta.length > 0 && (
            <span
              data-slot="chat-host-meta"
              className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground"
            >
              {meta.map((part, index) => (
                <span key={part} className="flex gap-x-1.5">
                  {index > 0 && <span aria-hidden="true">·</span>}
                  {part}
                </span>
              ))}
            </span>
          )}
        </div>
      )}
      {locked && (
        <div
          data-slot="chat-host-plan"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <span className="min-w-0 flex-1">
            {t("agent.chat.repeat.needsPlan")}
          </span>
          <Button
            type="button"
            size="sm"
            variant="soft"
            className="h-7 rounded-lg text-xs"
            onClick={host.onUpgrade}
          >
            {t("agent.setup.planAction")}
          </Button>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        {editable && (
          <Button
            type="button"
            variant="subtle"
            size="sm"
            aria-pressed={editing}
            data-slot="chat-host-edit"
            className={cn(
              "h-8 rounded-lg text-xs",
              editing && "bg-foreground/6",
            )}
            onClick={() => {
              setEditing((value) => !value);
            }}
          >
            {t("common.buttons.edit")}
          </Button>
        )}
        <span className="flex-1" />
        <Button
          type="button"
          variant="subtle"
          size="sm"
          disabled={busy}
          data-slot="chat-host-decline"
          className="h-8 rounded-lg text-xs"
          onClick={() => void answer(false)}
        >
          {t("common.buttons.cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={
            request.method === "routines.delete" ? "destructive" : "default"
          }
          disabled={busy || invalid}
          aria-busy={busy}
          data-slot="chat-host-approve"
          className="h-8 rounded-lg text-xs"
          onClick={() => void answer(true)}
        >
          {request.method === "routines.save"
            ? t("common.buttons.save")
            : request.method === "routines.delete"
              ? t("common.buttons.delete")
              : t("agent.routines.run")}
        </Button>
      </div>
    </section>
  );
}

/** What came of an answered change, one quiet line. */
function HostCallLine({ call, host }: { call: HostCall; host: HostContext }) {
  const { t } = useTranslation();
  const { request, outcome } = call;
  if (call.state === "declined") {
    return (
      <p
        data-slot="chat-host-done"
        data-state="declined"
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <LuX className="size-3 shrink-0" aria-hidden="true" />
        {t("agent.chat.host.declined")}
      </p>
    );
  }
  const batchId = outcome?.batchId ?? null;
  const routineId =
    request.method === "routines.save" ? (outcome?.routineId ?? null) : null;
  const text =
    request.method === "routines.save"
      ? t("agent.chat.host.saved", { name: request.routine.name })
      : request.method === "routines.delete"
        ? t("agent.chat.host.deleted", { name: request.name })
        : t("agent.chat.host.started", { count: outcome?.profiles ?? 0 });
  const target: PaneSelection | null =
    batchId && host.batches.some((batch) => batch.id === batchId)
      ? { kind: "run", id: batchId }
      : routineId
        ? { kind: "routine", id: routineId }
        : null;
  return (
    <p
      data-slot="chat-host-done"
      data-state="done"
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <LuCheck className="size-3 shrink-0 text-success" aria-hidden="true" />
      {target ? (
        <button
          type="button"
          data-slot="chat-host-open"
          onClick={() => {
            host.onOpen(target);
          }}
          className="cursor-pointer rounded underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {text}
        </button>
      ) : (
        text
      )}
    </p>
  );
}

/** The changes a turn asked for: open ones as cards, answered ones as lines. */
export function HostCalls({
  chatId,
  turn,
  host,
}: {
  chatId: string;
  turn: ChatTurn;
  host: HostContext;
}) {
  if (turn.hostCalls.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {turn.hostCalls.map((call) =>
        call.state === "pending" ? (
          <HostCallCard
            key={call.callId}
            chatId={chatId}
            call={call}
            host={host}
          />
        ) : (
          <HostCallLine key={call.callId} call={call} host={host} />
        ),
      )}
    </div>
  );
}
