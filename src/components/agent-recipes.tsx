"use client";

import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuPlay, LuPlus } from "react-icons/lu";
import { RecipeRecorder } from "@/components/agent-recipe-recorder";
import {
  emptyStep,
  isStepComplete,
  RecipeStepsEditor,
  tidyStep,
} from "@/components/agent-recipe-steps";
import { resolvedOs } from "@/components/cookie-bot-shared";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { LoadingButton } from "@/components/loading-button";
import { Button } from "@/components/ui/button";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ProBadge } from "@/components/ui/pro-badge";
import { RippleButton } from "@/components/ui/ripple";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { translateBackendError } from "@/lib/backend-errors";
import { isCookieBotPlatform } from "@/lib/cookie-bot";
import { MOTION_DURATION, MOTION_EASE_OUT, MOTION_SPRING } from "@/lib/motion";
import {
  type AgentRecipe,
  createAgentRecipe,
  deleteAgentRecipe,
  getAgentRecipes,
  type RecipeStep,
  updateAgentRecipe,
} from "@/lib/recipes";
import type { ScheduleTarget } from "@/lib/schedules";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { BrowserProfile } from "@/types";

interface AgentRecipesProps {
  /** Running profiles are the ones a recording can be made from. */
  profiles: BrowserProfile[];
  /** On-demand runs on this computer need browser automation. */
  canRunOnDesktop: boolean;
  /** Whether this computer is connected to Donut cloud for remote control. */
  desktopConnected: boolean;
}

export function AgentRecipes({
  profiles,
  canRunOnDesktop,
  desktopConnected,
}: AgentRecipesProps) {
  const { t } = useTranslation();
  const animate = useMotionAllowed();
  const [recipes, setRecipes] = useState<AgentRecipe[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const loadRecipes = useCallback(async () => {
    setIsLoading(true);
    try {
      setRecipes(await getAgentRecipes());
      setError(null);
    } catch (loadError) {
      setError(loadError);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRecipes();
  }, [loadRecipes]);
  /** The recipe being edited, `"new"` while composing one, or null. */
  const [editing, setEditing] = useState<AgentRecipe | "new" | null>(null);
  /** Steps a recording just produced, waiting to be reviewed and named. */
  const [recorded, setRecorded] = useState<RecipeStep[] | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<AgentRecipe | null>(
    null,
  );
  const [isRemoving, setIsRemoving] = useState(false);

  const confirmRemoval = useCallback(async () => {
    if (!pendingRemoval) return;
    setIsRemoving(true);
    try {
      await deleteAgentRecipe(pendingRemoval.id);
      showSuccessToast(t("agent.recipes.deleted"));
      setPendingRemoval(null);
      void loadRecipes();
    } catch (removeError) {
      showErrorToast(translateBackendError(t, removeError));
    } finally {
      setIsRemoving(false);
    }
  }, [pendingRemoval, loadRecipes, t]);

  return (
    <div
      data-slot="agent-recipes"
      className="flex min-h-0 flex-1 flex-col gap-3"
    >
      <div className="flex shrink-0 items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("agent.recipes.hint")}
        </p>
        <RippleButton
          size="sm"
          className="flex h-8 items-center gap-1.5 rounded-lg text-xs"
          disabled={editing !== null}
          onClick={() => {
            setEditing("new");
          }}
        >
          <LuPlus className="size-3.5" />
          {t("agent.recipes.new")}
        </RippleButton>
      </div>

      {error !== null && (
        <p className="shrink-0 rounded-xl bg-destructive/10 p-3 text-sm text-destructive-text">
          {translateBackendError(t, error)}
        </p>
      )}

      <RecipeRecorder
        profiles={profiles}
        onRecorded={(steps) => {
          // A recording is a draft, not a saved recipe: it opens the editor so
          // the person names it and sees every step before anything is stored.
          setRecorded(steps);
          setEditing("new");
        }}
      />

      {editing !== null && (
        <RecipeEditor
          recipe={editing === "new" ? null : editing}
          initialSteps={recorded}
          onCancel={() => {
            setEditing(null);
          }}
          onSaved={() => {
            setRecorded(null);
            setEditing(null);
            void loadRecipes();
          }}
        />
      )}

      <FadingScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 pr-1">
          {isLoading && recipes.length === 0 ? (
            Array.from({ length: 3 }, (_, index) => (
              <Skeleton
                key={`agent-recipe-skeleton-${index}`}
                className="h-12 w-full"
              />
            ))
          ) : recipes.length === 0 ? (
            <p
              data-slot="agent-recipes-empty"
              className="py-16 text-center text-sm text-muted-foreground"
            >
              {t("agent.recipes.empty")}
            </p>
          ) : (
            <AnimatePresence initial={false} mode="popLayout">
              {recipes.map((recipe, index) => (
                <motion.div
                  key={recipe.id}
                  data-slot="agent-recipe"
                  layout={animate ? "position" : false}
                  initial={animate ? { opacity: 0.6, y: 6 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  exit={
                    animate
                      ? {
                          opacity: 0,
                          scale: 0.98,
                          transition: { duration: MOTION_DURATION.fast },
                        }
                      : { opacity: 0, transition: { duration: 0 } }
                  }
                  transition={
                    animate
                      ? {
                          ...MOTION_SPRING.gentle,
                          delay: Math.min(index, 12) * 0.02,
                        }
                      : { duration: 0 }
                  }
                  className="flex items-center gap-3 rounded-xl bg-foreground/3 p-3 transition-colors duration-150 hover:bg-foreground/5"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-foreground">
                      {recipe.name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {t("agent.recipes.stepCount", {
                        steps: recipe.steps.length,
                      })}
                    </span>
                  </div>
                  <RecipeRunButton
                    recipe={recipe}
                    profiles={profiles}
                    canRunOnDesktop={canRunOnDesktop}
                    desktopConnected={desktopConnected}
                  />
                  <Button
                    variant="soft"
                    size="sm"
                    className="h-8 rounded-lg text-xs"
                    aria-label={t("agent.recipes.editAria", {
                      name: recipe.name,
                    })}
                    onClick={() => {
                      setEditing(recipe);
                    }}
                  >
                    {t("common.buttons.edit")}
                  </Button>
                  <Button
                    variant="subtle"
                    size="sm"
                    className="h-8 rounded-lg text-xs hover:bg-destructive/10 hover:text-destructive-text"
                    aria-label={t("agent.recipes.deleteAria", {
                      name: recipe.name,
                    })}
                    onClick={() => {
                      setPendingRemoval(recipe);
                    }}
                  >
                    {t("common.buttons.delete")}
                  </Button>
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        </div>
      </FadingScrollArea>

      <DeleteConfirmationDialog
        isOpen={pendingRemoval !== null}
        onClose={() => {
          setPendingRemoval(null);
        }}
        onConfirm={() => {
          void confirmRemoval();
        }}
        title={t("agent.recipes.deleteTitle", {
          name: pendingRemoval?.name ?? "",
        })}
        description={t("agent.recipes.deleteDescription")}
        confirmButtonText={t("common.buttons.delete")}
        isLoading={isRemoving}
      />
    </div>
  );
}

function RecipeEditor({
  recipe,
  initialSteps,
  onCancel,
  onSaved,
}: {
  recipe: AgentRecipe | null;
  /** Steps a recording produced, for a new recipe that starts from one. */
  initialSteps?: RecipeStep[] | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(recipe?.name ?? "");
  const [steps, setSteps] = useState<RecipeStep[]>(
    recipe?.steps ?? initialSteps ?? [],
  );
  const [isSaving, setIsSaving] = useState(false);

  // Editing a different recipe reuses this component, so the fields follow the
  // row the user actually clicked rather than keeping the previous one's text.
  useEffect(() => {
    setName(recipe?.name ?? "");
    setSteps(recipe?.steps ?? initialSteps ?? []);
  }, [recipe, initialSteps]);

  const canSave =
    name.trim().length > 0 &&
    steps.length > 0 &&
    steps.every(isStepComplete) &&
    !isSaving;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
      const payload = steps.map(tidyStep);
      if (recipe) {
        await updateAgentRecipe(recipe.id, name.trim(), payload);
        showSuccessToast(t("agent.recipes.updated"));
      } else {
        await createAgentRecipe(name.trim(), payload);
        showSuccessToast(t("agent.recipes.created"));
      }
      onSaved();
    } catch (saveError) {
      showErrorToast(translateBackendError(t, saveError));
    } finally {
      setIsSaving(false);
    }
  }, [canSave, recipe, name, steps, onSaved, t]);

  return (
    <form
      data-slot="agent-recipe-editor"
      className="flex shrink-0 flex-col gap-3 rounded-xl bg-foreground/3 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSave();
      }}
    >
      <div className="flex flex-col gap-2">
        <Label
          htmlFor="agent-recipe-name"
          className="text-xs font-medium text-muted-foreground"
        >
          {t("agent.recipes.name")}
        </Label>
        <Input
          id="agent-recipe-name"
          value={name}
          placeholder={t("agent.recipes.namePlaceholder")}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label className="text-xs font-medium text-muted-foreground">
          {t("agent.recipes.steps")}
        </Label>
        <RecipeStepsEditor
          steps={steps}
          onChange={setSteps}
          disabled={isSaving}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t("agent.recipes.stepsHint")}
          </p>
          <Button
            variant="soft"
            size="sm"
            type="button"
            className="h-8 gap-1.5 rounded-lg text-xs"
            disabled={isSaving}
            onClick={() => {
              setSteps([...steps, emptyStep("navigate")]);
            }}
          >
            <LuPlus className="size-3.5" />
            {t("agent.recipes.addStep")}
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="subtle"
          size="sm"
          className="h-8 rounded-lg text-xs"
          onClick={onCancel}
          type="button"
        >
          {t("common.buttons.cancel")}
        </Button>
        <RippleButton
          type="submit"
          size="sm"
          className="h-8 rounded-lg text-xs"
          disabled={!canSave}
        >
          {isSaving ? t("common.buttons.saving") : t("common.buttons.save")}
        </RippleButton>
      </div>
    </form>
  );
}

/**
 * Replays a saved recipe once on a profile the person picks. Donut cloud runs
 * it, on this computer through remote control or on the remote fleet.
 */
function RecipeRunButton({
  recipe,
  profiles,
  canRunOnDesktop,
  desktopConnected,
}: {
  recipe: AgentRecipe;
  profiles: BrowserProfile[];
  canRunOnDesktop: boolean;
  desktopConnected: boolean;
}) {
  const { t } = useTranslation();
  const animate = useMotionAllowed();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [profileId, setProfileId] = useState("");
  const [target, setTarget] = useState<ScheduleTarget>(
    canRunOnDesktop && desktopConnected ? "desktop" : "fleet",
  );
  const [isRunning, setIsRunning] = useState(false);
  const shownTarget: ScheduleTarget = canRunOnDesktop ? target : "fleet";
  const profile = profiles.find((item) => item.id === profileId) ?? null;
  const os = profile ? resolvedOs(profile) : null;
  const platform = os !== null && isCookieBotPlatform(os) ? os : null;
  const blocker =
    profile === null
      ? null
      : shownTarget === "fleet"
        ? platform
          ? null
          : t("agent.recipes.runPlatformUnsupported")
        : desktopConnected
          ? null
          : t("agent.recipes.runDesktopOffline");

  const run = async () => {
    if (!profile || blocker !== null) return;
    setIsRunning(true);
    try {
      await invoke("run_agent_recipe_now", {
        recipeId: recipe.id,
        profileId: profile.id,
        target: shownTarget,
        platform: shownTarget === "fleet" ? platform : null,
        name: t("agent.recipes.oneOffName", { name: recipe.name }),
      });
      showSuccessToast(t("agent.schedules.runStarted"), {
        description: t("agent.recipes.runStartedOn", {
          name: recipe.name,
          profile: profile.name,
        }),
      });
      setOpen(false);
    } catch (runError) {
      showErrorToast(translateBackendError(t, runError));
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="soft"
          size="sm"
          data-slot="agent-recipe-run"
          className="h-8 gap-1.5 rounded-lg text-xs"
          aria-label={t("agent.recipes.runAria", { name: recipe.name })}
          disabled={recipe.steps.length === 0}
        >
          <LuPlay className="size-3.5" aria-hidden="true" />
          {t("agent.schedules.runNow")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <form
          id={formId}
          data-slot="agent-recipe-run-form"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <div className="flex flex-col gap-1">
            <p className="truncate text-sm font-medium">
              {t("agent.recipes.runTitle", { name: recipe.name })}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("agent.recipes.runDescription")}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor={`${formId}-profile`}
              className="text-xs font-medium text-muted-foreground"
            >
              {t("agent.recipes.runProfile")}
            </Label>
            <Select value={profileId} onValueChange={setProfileId}>
              <SelectTrigger
                id={`${formId}-profile`}
                data-slot="agent-recipe-run-profile"
                className="w-full"
                disabled={profiles.length === 0}
              >
                <SelectValue
                  placeholder={
                    profiles.length === 0
                      ? t("agent.recipes.runNoProfiles")
                      : t("agent.recipes.runProfilePlaceholder")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor={`${formId}-target`}
              className="text-xs font-medium text-muted-foreground"
            >
              {t("agent.schedules.target")}
            </Label>
            <Select
              value={shownTarget}
              onValueChange={(value) => setTarget(value as ScheduleTarget)}
            >
              <SelectTrigger
                id={`${formId}-target`}
                data-slot="agent-recipe-run-target"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desktop" disabled={!canRunOnDesktop}>
                  <span className="flex items-center gap-2">
                    {t("agent.schedules.targetDesktop")}
                    {!canRunOnDesktop && <ProBadge />}
                  </span>
                </SelectItem>
                <SelectItem value="fleet">
                  {t("agent.schedules.targetFleet")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <AnimatePresence initial={false} mode="popLayout">
            {blocker !== null && (
              <motion.p
                key={blocker}
                role="status"
                data-slot="agent-recipe-run-blocker"
                initial={animate ? { opacity: 0.6, y: -2 } : false}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0 } }}
                transition={
                  animate
                    ? { duration: MOTION_DURATION.base, ease: MOTION_EASE_OUT }
                    : { duration: 0 }
                }
                className="text-xs leading-relaxed text-warning-text"
              >
                {blocker}
              </motion.p>
            )}
          </AnimatePresence>
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
            <LoadingButton
              type="submit"
              size="sm"
              data-slot="agent-recipe-run-start"
              className="h-8 rounded-lg text-xs"
              isLoading={isRunning}
              disabled={profile === null || blocker !== null}
            >
              {t("agent.schedules.runNow")}
            </LoadingButton>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
