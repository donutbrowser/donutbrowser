"use client";

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuSettings2 } from "react-icons/lu";
import {
  ProfilePicker,
  useScheduleWords,
} from "@/components/agent-tasks/parts";
import { AnimatedSwitch } from "@/components/ui/animated-switch";
import { Button } from "@/components/ui/button";
import { SoftFields } from "@/components/ui/field-variant";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RippleButton } from "@/components/ui/ripple";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentRoutine,
  type AgentRoutineDraft,
  createAgentRoutine,
  isCron,
  isWebUrl,
  MAX_CONCURRENCY,
  MAX_PROMPT_CHARS,
  updateAgentRoutine,
} from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { BrowserProfile } from "@/types";

const LABEL = "text-xs font-medium text-muted-foreground";
const DEFAULT_CRON = "0 9 * * 1-5";

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function countOrNull(value: string, max?: number): number | null {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return max ? Math.min(parsed, max) : parsed;
}

/** Create or change a routine: a saved task, its profiles and its schedule. */
export function RoutineEditor({
  routine,
  profiles,
  canSchedule,
  onCancel,
  onSaved,
}: {
  routine: AgentRoutine | null;
  profiles: BrowserProfile[];
  canSchedule: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [startUrl, setStartUrl] = useState(routine?.startUrl ?? "");
  const [profileIds, setProfileIds] = useState<string[]>(
    routine?.profileIds ?? [],
  );
  const [scheduled, setScheduled] = useState(
    canSchedule && routine?.schedule != null,
  );
  const [cron, setCron] = useState(routine?.schedule?.cron ?? DEFAULT_CRON);
  const [timezone, setTimezone] = useState(
    routine?.schedule?.timezone ?? localTimezone(),
  );
  const [maxCredits, setMaxCredits] = useState(
    routine?.maxCreditsPerRun ? String(routine.maxCreditsPerRun) : "",
  );
  const [concurrency, setConcurrency] = useState(
    routine?.concurrency ? String(routine.concurrency) : "",
  );
  const [saving, setSaving] = useState(false);

  const url = startUrl.trim();
  const urlInvalid = url.length > 0 && !isWebUrl(url);
  const cronInvalid = scheduled && !isCron(cron);
  const canSave =
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    profileIds.length > 0 &&
    !urlInvalid &&
    !cronInvalid &&
    timezone.trim().length > 0 &&
    !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const draft: AgentRoutineDraft = {
      name: name.trim(),
      prompt: prompt.trim(),
      startUrl: url || null,
      profileIds,
      schedule: scheduled
        ? { cron: cron.trim(), timezone: timezone.trim() }
        : null,
      maxCreditsPerRun: countOrNull(maxCredits),
      concurrency: countOrNull(concurrency, MAX_CONCURRENCY),
      enabled: routine?.enabled ?? true,
    };
    try {
      if (routine) {
        await updateAgentRoutine(routine.id, draft);
        showSuccessToast(t("agent.routines.updated"));
      } else {
        await createAgentRoutine(draft);
        showSuccessToast(t("agent.routines.created"));
      }
      onSaved();
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setSaving(false);
    }
  };

  const scheduleWords = useScheduleWords();
  const tuned = maxCredits.trim() !== "" || concurrency.trim() !== "";

  return (
    <form
      data-slot="agent-routine-editor"
      className="flex shrink-0 flex-col gap-3 rounded-2xl bg-foreground/3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <SoftFields>
        <Label htmlFor={`${formId}-name`} className="sr-only">
          {t("agent.routines.name")}
        </Label>
        <Input
          id={`${formId}-name`}
          variant="bare"
          value={name}
          maxLength={120}
          placeholder={t("agent.routines.namePlaceholder")}
          data-slot="agent-routine-name"
          className="h-8 text-base font-medium md:text-base"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <Label htmlFor={`${formId}-prompt`} className="sr-only">
          {t("agent.routines.prompt")}
        </Label>
        <Textarea
          id={`${formId}-prompt`}
          rows={3}
          value={prompt}
          maxLength={MAX_PROMPT_CHARS}
          placeholder={t("agent.tasks.promptPlaceholder")}
          data-slot="agent-routine-prompt"
          className="min-h-20 resize-none rounded-xl px-3.5 py-3 text-sm leading-relaxed"
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`${formId}-profiles`} className="sr-only">
            {t("agent.routines.profiles")}
          </Label>
          <ProfilePicker
            id={`${formId}-profiles`}
            profiles={profiles}
            selected={profileIds}
            onChange={setProfileIds}
          />
          <Label htmlFor={`${formId}-url`} className="sr-only">
            {t("agent.tasks.startUrl")}
          </Label>
          <Input
            id={`${formId}-url`}
            value={startUrl}
            inputMode="url"
            aria-invalid={urlInvalid}
            placeholder={t("agent.tasks.startUrlPlaceholder")}
            className="h-8 w-60 min-w-0 shrink text-xs md:text-xs"
            onChange={(event) => {
              setStartUrl(event.target.value);
            }}
          />
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="subtle"
                size="sm"
                aria-label={t("agent.tasks.options")}
                title={t("agent.tasks.options")}
                className={cn(
                  "h-8 rounded-lg px-2.5",
                  tuned && "bg-foreground/6 text-foreground",
                )}
              >
                <LuSettings2 className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="grid w-72 grid-cols-2 gap-2 p-3"
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${formId}-credits`} className={LABEL}>
                  {t("agent.routines.creditCap")}
                </Label>
                <Input
                  id={`${formId}-credits`}
                  type="number"
                  min={1}
                  value={maxCredits}
                  placeholder={t("agent.tasks.noCap")}
                  className="h-8 text-xs md:text-xs"
                  onChange={(event) => {
                    setMaxCredits(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${formId}-concurrency`} className={LABEL}>
                  {t("agent.tasks.concurrency")}
                </Label>
                <Input
                  id={`${formId}-concurrency`}
                  type="number"
                  min={1}
                  max={MAX_CONCURRENCY}
                  value={concurrency}
                  placeholder={t("agent.tasks.concurrencyDefault")}
                  className="h-8 text-xs md:text-xs"
                  onChange={(event) => {
                    setConcurrency(event.target.value);
                  }}
                />
              </div>
            </PopoverContent>
          </Popover>
        </div>

        {canSchedule && (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <AnimatedSwitch
                id={`${formId}-scheduled`}
                checked={scheduled}
                data-slot="agent-routine-scheduled"
                onCheckedChange={setScheduled}
              />
              <Label htmlFor={`${formId}-scheduled`} className="text-sm">
                {t("agent.routines.onSchedule")}
              </Label>
              {scheduled && !cronInvalid && (
                <span className="truncate text-xs text-muted-foreground">
                  {scheduleWords({ cron, timezone })}
                </span>
              )}
            </div>
            {scheduled && (
              <div className="flex flex-wrap items-start gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${formId}-cron`} className="sr-only">
                    {t("agent.routines.cron")}
                  </Label>
                  <Input
                    id={`${formId}-cron`}
                    value={cron}
                    aria-invalid={cronInvalid}
                    data-slot="agent-routine-cron"
                    className="h-8 w-40 font-mono text-xs md:text-xs"
                    onChange={(event) => {
                      setCron(event.target.value);
                    }}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    {t("agent.routines.cronHint")}
                  </span>
                </div>
                <Label htmlFor={`${formId}-timezone`} className="sr-only">
                  {t("agent.routines.timezone")}
                </Label>
                <Input
                  id={`${formId}-timezone`}
                  value={timezone}
                  className="h-8 w-48 text-xs md:text-xs"
                  onChange={(event) => {
                    setTimezone(event.target.value);
                  }}
                />
              </div>
            )}
          </div>
        )}
      </SoftFields>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="subtle"
          size="sm"
          className="h-8 rounded-lg text-xs"
          onClick={onCancel}
        >
          {t("common.buttons.cancel")}
        </Button>
        <RippleButton
          type="submit"
          size="sm"
          disabled={!canSave}
          data-slot="agent-routine-save"
          className="h-8 rounded-lg text-xs"
        >
          {saving ? t("common.buttons.saving") : t("common.buttons.save")}
        </RippleButton>
      </div>
    </form>
  );
}
