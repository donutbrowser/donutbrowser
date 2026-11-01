"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuSettings2, LuSparkles } from "react-icons/lu";
import { ProfilePicker } from "@/components/agent-tasks/parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { RippleButton } from "@/components/ui/ripple";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentAutonomy,
  type AgentBatch,
  isWebUrl,
  MAX_CONCURRENCY,
  MAX_PROMPT_CHARS,
  startAgentBatch,
} from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { BrowserProfile } from "@/types";

function positiveInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Write a task and send it to one or many profiles. */
export function TaskComposer({
  profiles,
  seedProfileIds,
  compact,
  onStarted,
}: {
  profiles: BrowserProfile[];
  /** Profiles chosen elsewhere, such as the profiles table selection. */
  seedProfileIds: string[] | null;
  /** One line until it is used, so a run below keeps the room. */
  compact: boolean;
  onStarted: (batch: AgentBatch) => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState("");
  const [profileIds, setProfileIds] = useState<string[]>([]);
  const [startUrl, setStartUrl] = useState("");
  const [autonomy, setAutonomy] = useState<AgentAutonomy>("ask");
  const [maxCredits, setMaxCredits] = useState("");
  const [concurrency, setConcurrency] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (seedProfileIds && seedProfileIds.length > 0) {
      setProfileIds(seedProfileIds);
      promptRef.current?.focus();
    }
  }, [seedProfileIds]);

  const known = new Set(profiles.map((profile) => profile.id));
  const chosen = profileIds.filter((id) => known.has(id));
  const url = startUrl.trim();
  const urlInvalid = url.length > 0 && !isWebUrl(url);
  const canRun =
    prompt.trim().length > 0 && chosen.length > 0 && !urlInvalid && !busy;
  const tuned =
    autonomy === "auto" ||
    maxCredits.trim() !== "" ||
    concurrency.trim() !== "";

  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    try {
      const batch = await startAgentBatch({
        profileIds: chosen,
        prompt: prompt.trim(),
        startUrl: url || null,
        autonomy,
        maxCredits: positiveInt(maxCredits),
        concurrency: positiveInt(concurrency),
      });
      setPrompt("");
      onStarted(batch);
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      data-slot="agent-task-composer"
      className="flex shrink-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void run();
      }}
    >
      <Label htmlFor={`${formId}-prompt`} className="sr-only">
        {t("agent.tasks.promptLabel")}
      </Label>
      <Textarea
        ref={promptRef}
        id={`${formId}-prompt`}
        variant="soft"
        rows={1}
        value={prompt}
        maxLength={MAX_PROMPT_CHARS}
        placeholder={t("agent.tasks.promptPlaceholder")}
        data-slot="agent-task-prompt"
        className={cn(
          "max-h-48 resize-none rounded-xl px-3.5 py-2.5 text-sm leading-relaxed field-sizing-content",
          compact && prompt.length === 0
            ? "min-h-10 focus-visible:min-h-20"
            : "min-h-20",
        )}
        onChange={(event) => {
          setPrompt(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void run();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <ProfilePicker
          profiles={profiles}
          selected={chosen}
          onChange={setProfileIds}
          disabled={busy}
        />
        <Label htmlFor={`${formId}-url`} className="sr-only">
          {t("agent.tasks.startUrl")}
        </Label>
        <Input
          id={`${formId}-url`}
          value={startUrl}
          inputMode="url"
          placeholder={t("agent.tasks.startUrlPlaceholder")}
          aria-invalid={urlInvalid}
          variant="soft"
          data-slot="agent-task-url"
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
              data-slot="agent-task-options"
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
          <PopoverContent align="end" className="flex w-72 flex-col gap-3 p-3">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {t("agent.tasks.autonomy")}
              </span>
              <RadioGroup
                value={autonomy}
                onValueChange={(value) => setAutonomy(value as AgentAutonomy)}
                className="gap-2"
              >
                {(["ask", "auto"] as const).map((value) => (
                  <div key={value} className="flex items-start gap-2">
                    <RadioGroupItem
                      id={`${formId}-autonomy-${value}`}
                      value={value}
                      className="mt-0.5"
                    />
                    <Label
                      htmlFor={`${formId}-autonomy-${value}`}
                      className="flex flex-col items-start gap-0.5 text-sm font-normal"
                    >
                      {t(`agent.tasks.autonomyOptions.${value}`)}
                      <span className="text-xs text-muted-foreground">
                        {t(`agent.tasks.autonomyHints.${value}`)}
                      </span>
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1.5">
                <Label
                  htmlFor={`${formId}-credits`}
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("agent.tasks.creditCap")}
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
                <Label
                  htmlFor={`${formId}-concurrency`}
                  className="text-xs font-medium text-muted-foreground"
                >
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
            </div>
          </PopoverContent>
        </Popover>
        <RippleButton
          type="submit"
          size="sm"
          disabled={!canRun}
          aria-busy={busy}
          data-slot="agent-task-run"
          className="ml-auto h-8 gap-1.5 rounded-lg text-xs"
        >
          <LuSparkles className="size-3.5" aria-hidden="true" />
          {chosen.length > 0
            ? t("agent.tasks.runOn", { count: chosen.length })
            : t("agent.tasks.run")}
        </RippleButton>
      </div>
    </form>
  );
}
