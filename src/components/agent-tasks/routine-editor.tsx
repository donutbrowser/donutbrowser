"use client";

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProfilePicker } from "@/components/agent-tasks/parts";
import { AnimatedSwitch } from "@/components/ui/animated-switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProBadge } from "@/components/ui/pro-badge";
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

  return (
    <form
      data-slot="agent-routine-editor"
      className="flex shrink-0 flex-col gap-3 rounded-2xl bg-foreground/3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${formId}-name`} className={LABEL}>
          {t("agent.routines.name")}
        </Label>
        <Input
          id={`${formId}-name`}
          value={name}
          maxLength={120}
          placeholder={t("agent.routines.namePlaceholder")}
          data-slot="agent-routine-name"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${formId}-prompt`} className={LABEL}>
          {t("agent.routines.prompt")}
        </Label>
        <Textarea
          id={`${formId}-prompt`}
          rows={3}
          value={prompt}
          maxLength={MAX_PROMPT_CHARS}
          placeholder={t("agent.tasks.promptPlaceholder")}
          data-slot="agent-routine-prompt"
          className="min-h-20 resize-none text-sm leading-relaxed"
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
        />
      </div>
      <div className="grid gap-3 @lg:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${formId}-url`} className={LABEL}>
            {t("agent.tasks.startUrl")}
          </Label>
          <Input
            id={`${formId}-url`}
            value={startUrl}
            inputMode="url"
            aria-invalid={urlInvalid}
            placeholder={t("agent.tasks.startUrlPlaceholder")}
            onChange={(event) => {
              setStartUrl(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${formId}-profiles`} className={LABEL}>
            {t("agent.routines.profiles")}
          </Label>
          <ProfilePicker
            id={`${formId}-profiles`}
            profiles={profiles}
            selected={profileIds}
            onChange={setProfileIds}
          />
        </div>
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
            onChange={(event) => {
              setConcurrency(event.target.value);
            }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <AnimatedSwitch
            id={`${formId}-scheduled`}
            checked={scheduled}
            disabled={!canSchedule}
            data-slot="agent-routine-scheduled"
            onCheckedChange={setScheduled}
          />
          <Label htmlFor={`${formId}-scheduled`} className="text-sm">
            {t("agent.routines.onSchedule")}
          </Label>
          {!canSchedule && <ProBadge />}
        </div>
        {!canSchedule && (
          <p className="text-xs text-muted-foreground">
            {t("agent.routines.scheduleNeedsPlan")}
          </p>
        )}
        {scheduled && (
          <div className="grid gap-3 @lg:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-cron`} className={LABEL}>
                {t("agent.routines.cron")}
              </Label>
              <Input
                id={`${formId}-cron`}
                value={cron}
                aria-invalid={cronInvalid}
                data-slot="agent-routine-cron"
                className="font-mono"
                onChange={(event) => {
                  setCron(event.target.value);
                }}
              />
              <span className="text-[11px] text-muted-foreground">
                {t("agent.routines.cronHint")}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-timezone`} className={LABEL}>
                {t("agent.routines.timezone")}
              </Label>
              <Input
                id={`${formId}-timezone`}
                value={timezone}
                onChange={(event) => {
                  setTimezone(event.target.value);
                }}
              />
            </div>
          </div>
        )}
      </div>

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
