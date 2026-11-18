"use client";

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuPlus } from "react-icons/lu";
import { SidebarToggle } from "@/components/agent-shell";
import { PaneHeader } from "@/components/agent-tasks/parts";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { AnimatedSwitch } from "@/components/ui/animated-switch";
import { Button } from "@/components/ui/button";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RippleButton } from "@/components/ui/ripple";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAgentPlaybooks } from "@/hooks/use-agent-playbooks";
import {
  type AgentPlaybook,
  createAgentPlaybook,
  deleteAgentPlaybook,
  MAX_PLAYBOOK_CHARS,
  splitSites,
  updateAgentPlaybook,
} from "@/lib/agent-playbooks";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";

const EMPTY = { name: "", instructions: "", sites: [], shared: false };

function PlaybookEditor({
  playbook,
  onDone,
}: {
  /** None for a new playbook. */
  playbook: AgentPlaybook | null;
  onDone: (saved: AgentPlaybook | null) => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const initial = playbook ?? EMPTY;
  const [name, setName] = useState(initial.name);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [sites, setSites] = useState(initial.sites.join(", "));
  const [shared, setShared] = useState(initial.shared);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const readOnly = playbook !== null && !playbook.editable;
  const canSave =
    !readOnly &&
    name.trim().length > 0 &&
    instructions.trim().length > 0 &&
    !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const draft = {
      name: name.trim(),
      instructions: instructions.trim(),
      sites: splitSites(sites),
      shared,
    };
    try {
      const saved = playbook
        ? await updateAgentPlaybook(playbook.id, draft)
        : await createAgentPlaybook(draft);
      showSuccessToast(t("agent.playbooks.saved"));
      onDone(saved);
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      data-slot="agent-playbook-editor"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Label htmlFor={`${formId}-name`} className="sr-only">
        {t("agent.playbooks.name")}
      </Label>
      <Input
        id={`${formId}-name`}
        variant="bare"
        value={name}
        readOnly={readOnly}
        maxLength={120}
        placeholder={t("agent.playbooks.namePlaceholder")}
        data-slot="agent-playbook-name"
        className="h-8 text-base font-medium md:text-base"
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <Label htmlFor={`${formId}-instructions`} className="sr-only">
        {t("agent.playbooks.instructions")}
      </Label>
      <Textarea
        id={`${formId}-instructions`}
        rows={5}
        value={instructions}
        readOnly={readOnly}
        maxLength={MAX_PLAYBOOK_CHARS}
        placeholder={t("agent.playbooks.instructionsPlaceholder")}
        data-slot="agent-playbook-instructions"
        className="max-h-80 min-h-28 resize-none rounded-xl px-3.5 py-3 text-sm leading-relaxed field-sizing-content"
        onChange={(event) => {
          setInstructions(event.target.value);
        }}
      />
      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor={`${formId}-sites`}
          className="text-xs font-medium text-muted-foreground"
        >
          {t("agent.playbooks.sites")}
        </Label>
        <Input
          id={`${formId}-sites`}
          value={sites}
          readOnly={readOnly}
          placeholder="shop.example.com"
          data-slot="agent-playbook-sites"
          className="h-8 text-xs md:text-xs"
          onChange={(event) => {
            setSites(event.target.value);
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <AnimatedSwitch
          id={`${formId}-shared`}
          checked={shared}
          disabled={readOnly}
          data-slot="agent-playbook-shared"
          onCheckedChange={setShared}
        />
        <Label htmlFor={`${formId}-shared`} className="text-xs">
          {t("agent.playbooks.shared")}
        </Label>
        <div className="ml-auto flex items-center gap-2">
          {playbook && !readOnly && (
            <Button
              type="button"
              variant="subtle"
              size="sm"
              data-slot="agent-playbook-delete"
              className="h-8 rounded-lg text-xs hover:bg-destructive/10 hover:text-destructive-text"
              onClick={() => {
                setRemoving(true);
              }}
            >
              {t("common.buttons.delete")}
            </Button>
          )}
          <Button
            type="button"
            variant="subtle"
            size="sm"
            className="h-8 rounded-lg text-xs"
            onClick={() => {
              onDone(null);
            }}
          >
            {readOnly ? t("common.buttons.close") : t("common.buttons.cancel")}
          </Button>
          {!readOnly && (
            <RippleButton
              type="submit"
              size="sm"
              disabled={!canSave}
              data-slot="agent-playbook-save"
              className="h-8 rounded-lg text-xs"
            >
              {saving ? t("common.buttons.saving") : t("common.buttons.save")}
            </RippleButton>
          )}
        </div>
      </div>
      {playbook && (
        <DeleteConfirmationDialog
          isOpen={removing}
          onClose={() => {
            setRemoving(false);
          }}
          onConfirm={async () => {
            try {
              await deleteAgentPlaybook(playbook.id);
              setRemoving(false);
              onDone(null);
            } catch (error) {
              showErrorToast(translateBackendError(t, error));
            }
          }}
          title={t("agent.playbooks.deleteTitle", { name: playbook.name })}
          description={t("agent.playbooks.deleteDescription")}
          confirmButtonText={t("common.buttons.delete")}
        />
      )}
    </form>
  );
}

/**
 * Playbooks: know-how for a site that tasks there get in their prompt,
 * personal or shared with the team.
 */
export function PlaybooksPane() {
  const { t } = useTranslation();
  const { playbooks, error, reload } = useAgentPlaybooks(true);
  // "new", a playbook's id, or nothing open.
  const [open, setOpen] = useState<string | null>(null);

  const done = () => {
    setOpen(null);
    reload();
  };

  return (
    <section
      data-slot="agent-playbooks"
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
    >
      <PaneHeader lead={<SidebarToggle />} title={t("agent.playbooks.title")}>
        {open === null && (
          <Button
            variant="soft"
            size="sm"
            data-slot="agent-playbook-new"
            className="h-8 gap-1.5 rounded-lg text-xs"
            onClick={() => {
              setOpen("new");
            }}
          >
            <LuPlus className="size-3.5" aria-hidden="true" />
            {t("agent.playbooks.new")}
          </Button>
        )}
      </PaneHeader>
      <FadingScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 py-1">
          {open === "new" && <PlaybookEditor playbook={null} onDone={done} />}
          {error !== null && (
            <p className="px-2 text-xs text-destructive-text">
              {translateBackendError(t, error)}
            </p>
          )}
          {playbooks === null && error === null && (
            <Skeleton className="h-12 w-full" />
          )}
          {playbooks?.length === 0 && open !== "new" && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {t("agent.playbooks.empty")}
            </p>
          )}
          <ul className="flex flex-col gap-0.5">
            {(playbooks ?? []).map((playbook) =>
              open === playbook.id ? (
                <li key={playbook.id} className="py-2">
                  <PlaybookEditor playbook={playbook} onDone={done} />
                </li>
              ) : (
                <li key={playbook.id}>
                  <button
                    type="button"
                    data-slot="agent-playbook-item"
                    data-playbook-id={playbook.id}
                    onClick={() => {
                      setOpen(playbook.id);
                    }}
                    className="flex w-full cursor-pointer flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
                  >
                    <span className="truncate text-sm">{playbook.name}</span>
                    <span className="flex min-w-0 gap-1.5 text-xs text-muted-foreground">
                      <span className="truncate">
                        {playbook.sites.length > 0
                          ? playbook.sites.join(", ")
                          : t("agent.playbooks.anySite")}
                      </span>
                      {playbook.shared && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="shrink-0">
                            {t("agent.playbooks.team")}
                          </span>
                        </>
                      )}
                    </span>
                  </button>
                </li>
              ),
            )}
          </ul>
        </div>
      </FadingScrollArea>
    </section>
  );
}
