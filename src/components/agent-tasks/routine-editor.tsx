"use client";

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ProfilePicker,
  positiveInt,
  RunOptions,
  type RunSettings,
  startUrlInvalid,
} from "@/components/agent-tasks/parts";
import {
  type Repeat,
  RepeatPicker,
  repeatInvalid,
  repeatOf,
  scheduleOf,
} from "@/components/agent-tasks/repeat-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RippleButton } from "@/components/ui/ripple";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentRoutine,
  type AgentRoutineDraft,
  createAgentRoutine,
  MAX_CONCURRENCY,
  MAX_PROMPT_CHARS,
  updateAgentRoutine,
} from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { BrowserProfile, GroupWithCount } from "@/types";

/** Create a routine (`id` null) or change one: its task, profiles and schedule. */
export function RoutineEditor({
  id,
  initial,
  profiles,
  groups,
  canSchedule,
  onUpgrade,
  onCancel,
  onSaved,
}: {
  id: string | null;
  initial: AgentRoutineDraft;
  profiles: BrowserProfile[];
  groups: GroupWithCount[];
  canSchedule: boolean;
  onUpgrade: () => void;
  onCancel: () => void;
  onSaved: (routine: AgentRoutine) => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [name, setName] = useState(initial.name);
  const [prompt, setPrompt] = useState(initial.prompt);
  const [profileIds, setProfileIds] = useState<string[]>(initial.profileIds);
  const [repeat, setRepeat] = useState<Repeat>(() =>
    repeatOf(canSchedule ? initial.schedule : null),
  );
  const [settings, setSettings] = useState<RunSettings>({
    startUrl: initial.startUrl ?? "",
    autonomy: "auto",
    maxCredits: initial.maxCreditsPerRun
      ? String(initial.maxCreditsPerRun)
      : "",
    concurrency: initial.concurrency ? String(initial.concurrency) : "",
  });
  const [saving, setSaving] = useState(false);

  const canSave =
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    profileIds.length > 0 &&
    !startUrlInvalid(settings) &&
    !repeatInvalid(repeat) &&
    !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const draft: AgentRoutineDraft = {
      name: name.trim(),
      prompt: prompt.trim(),
      startUrl: settings.startUrl.trim() || null,
      profileIds,
      schedule: scheduleOf(repeat),
      maxCreditsPerRun: positiveInt(settings.maxCredits),
      concurrency: positiveInt(settings.concurrency, MAX_CONCURRENCY),
      enabled: initial.enabled,
    };
    try {
      const saved = id
        ? await updateAgentRoutine(id, draft)
        : await createAgentRoutine(draft);
      showSuccessToast(
        t(id ? "agent.routines.updated" : "agent.routines.created"),
      );
      onSaved(saved);
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      data-slot="agent-routine-editor"
      className="flex shrink-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
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
        variant="soft"
        rows={3}
        value={prompt}
        maxLength={MAX_PROMPT_CHARS}
        placeholder={t("agent.tasks.promptPlaceholder")}
        data-slot="agent-routine-prompt"
        className="max-h-60 min-h-20 resize-none rounded-xl px-3.5 py-3 text-sm leading-relaxed field-sizing-content"
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
          groups={groups}
          selected={profileIds}
          onChange={setProfileIds}
          className="rounded-xl"
        />
        <RepeatPicker
          value={repeat}
          onChange={setRepeat}
          allowOnce={false}
          canSchedule={canSchedule}
          onUpgrade={onUpgrade}
        />
        <RunOptions
          value={settings}
          onChange={setSettings}
          creditCapLabel={t("agent.routines.creditCap")}
          align="start"
        />
        <div className="ml-auto flex items-center gap-2">
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
      </div>
    </form>
  );
}
