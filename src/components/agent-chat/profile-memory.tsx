"use client";

import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuTrash2 } from "react-icons/lu";
import { SidebarToggle } from "@/components/agent-shell";
import {
  PaneHeader,
  ProfilePicker,
  useNumber,
} from "@/components/agent-tasks/parts";
import { AnimatedSwitch } from "@/components/ui/animated-switch";
import { Button } from "@/components/ui/button";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AgentActionUsage,
  type AgentNote,
  type AgentProfileMemory,
  type AgentSite,
  deleteAgentMemoryNote,
  getAgentActionUsage,
  getAgentProfileMemory,
  getAgentProfileSites,
  MAX_NOTE_CHARS,
  MEMORY_CHANGED,
  saveAgentMemoryNote,
  setAgentHistoryUse,
} from "@/lib/agent-profile";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast } from "@/lib/toast-utils";
import type { BrowserProfile, GroupWithCount } from "@/types";

const SECTION_LABEL = "px-2 text-xs font-medium text-muted-foreground";
const SITES_SHOWN = 6;

function NoteRow({
  note,
  onSave,
  onDelete,
}: {
  note: AgentNote;
  onSave: (text: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  if (editing !== null) {
    return (
      <li>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(editing).then((ok) => {
              if (ok) setEditing(null);
            });
          }}
        >
          <Input
            autoFocus
            value={editing}
            maxLength={MAX_NOTE_CHARS}
            aria-label={t("agent.memory.note")}
            data-slot="agent-note-edit"
            className="h-8 text-sm"
            onChange={(event) => {
              setEditing(event.target.value);
            }}
            onBlur={() => {
              setEditing(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(null);
            }}
          />
        </form>
      </li>
    );
  }
  return (
    <li
      data-slot="agent-note"
      data-learnt={note.learnt ? "true" : "false"}
      className="group/note flex min-h-8 items-center gap-2 rounded-lg px-2 hover:bg-foreground/5"
    >
      <button
        type="button"
        className="min-w-0 flex-1 cursor-text py-1.5 text-left text-sm leading-5"
        title={t("agent.memory.edit")}
        onClick={() => {
          setEditing(note.text);
        }}
      >
        {note.text}
      </button>
      <Button
        type="button"
        variant="subtle"
        size="sm"
        aria-label={t("agent.memory.delete")}
        title={t("agent.memory.delete")}
        data-slot="agent-note-delete"
        className="size-7 shrink-0 rounded-lg p-0 opacity-0 group-hover/note:opacity-100 focus-visible:opacity-100"
        onClick={onDelete}
      >
        <LuTrash2 className="size-3.5" aria-hidden="true" />
      </Button>
    </li>
  );
}

/** A profile's actions today, in a line: "42 actions today · shop.example 30". */
function Usage({ usage }: { usage: AgentActionUsage | null }) {
  const { t } = useTranslation();
  const format = useNumber();
  if (!usage || usage.actions === 0) return null;
  return (
    <p
      data-slot="agent-usage"
      className="flex flex-wrap gap-x-1.5 px-2 text-xs text-muted-foreground"
    >
      <span>
        {t("agent.memory.actionsToday", {
          count: usage.actions,
          n: format(usage.actions),
        })}
      </span>
      {usage.sites.slice(0, SITES_SHOWN).map((site) => (
        <span key={site.host} className="flex gap-1.5">
          <span aria-hidden="true">·</span>
          <span>
            {site.host} {format(site.actions)}
          </span>
        </span>
      ))}
    </p>
  );
}

/**
 * What the agent knows about a profile: its notes, to read, edit and delete;
 * whether it reads the profile's history; and its actions today.
 */
export function ProfileMemoryPane({
  profileId,
  profiles,
  groups,
  onProfile,
}: {
  profileId: string | null;
  profiles: BrowserProfile[];
  groups: GroupWithCount[];
  onProfile: (profileId: string) => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [memory, setMemory] = useState<AgentProfileMemory | null>(null);
  const [sites, setSites] = useState<AgentSite[] | null>(null);
  const [usage, setUsage] = useState<AgentActionUsage | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!profileId) return;
    getAgentProfileMemory(profileId)
      .then(setMemory)
      .catch((error: unknown) => {
        showErrorToast(translateBackendError(t, error));
      });
  }, [profileId, t]);

  useEffect(() => {
    setMemory(null);
    setSites(null);
    setUsage(null);
    if (!profileId) return;
    load();
    getAgentActionUsage(profileId)
      .then(setUsage)
      .catch(() => {
        setUsage(null);
      });
    const unlisten = listen<{ profileId: string }>(MEMORY_CHANGED, (event) => {
      if (event.payload.profileId === profileId) load();
    });
    return () => {
      void unlisten.then((off) => {
        off();
      });
    };
  }, [profileId, load]);

  const useHistory = memory?.useHistory ?? false;
  useEffect(() => {
    if (!profileId || !useHistory) {
      setSites(null);
      return;
    }
    let cancelled = false;
    getAgentProfileSites(profileId)
      .then((list) => {
        if (!cancelled) setSites(list);
      })
      .catch(() => {
        if (!cancelled) setSites([]);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, useHistory]);

  const change = async (
    work: () => Promise<AgentProfileMemory>,
  ): Promise<boolean> => {
    setBusy(true);
    try {
      setMemory(await work());
      return true;
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!profileId || !draft.trim()) return;
    if (await change(() => saveAgentMemoryNote(profileId, null, draft))) {
      setDraft("");
    }
  };

  return (
    <section
      data-slot="agent-memory"
      data-profile-id={profileId ?? undefined}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
    >
      <PaneHeader lead={<SidebarToggle />} title={t("agent.memory.title")}>
        <ProfilePicker
          profiles={profiles}
          groups={groups}
          single
          selected={profileId ? [profileId] : []}
          onChange={(ids) => {
            if (ids[0]) onProfile(ids[0]);
          }}
          className="rounded-xl"
        />
      </PaneHeader>
      <FadingScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 py-1">
          {!profileId ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {t("agent.memory.choose")}
            </p>
          ) : !memory ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <Usage usage={usage} />
              <div className="flex flex-col gap-1.5">
                <span className={SECTION_LABEL}>{t("agent.memory.notes")}</span>
                <form
                  className="flex items-center gap-1.5 px-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void add();
                  }}
                >
                  <Label htmlFor={`${formId}-note`} className="sr-only">
                    {t("agent.memory.note")}
                  </Label>
                  <Input
                    id={`${formId}-note`}
                    value={draft}
                    maxLength={MAX_NOTE_CHARS}
                    placeholder={t("agent.memory.notePlaceholder")}
                    data-slot="agent-note-input"
                    className="h-8 min-w-0 flex-1 text-sm"
                    onChange={(event) => {
                      setDraft(event.target.value);
                    }}
                  />
                  <Button
                    type="submit"
                    variant="soft"
                    size="sm"
                    disabled={busy || !draft.trim()}
                    data-slot="agent-note-add"
                    className="h-8 rounded-lg text-xs"
                  >
                    {t("agent.memory.add")}
                  </Button>
                </form>
                {memory.notes.length === 0 ? (
                  <p className="px-2 text-xs text-muted-foreground">
                    {t("agent.memory.empty")}
                  </p>
                ) : (
                  <ul data-slot="agent-notes" className="flex flex-col">
                    {memory.notes.map((note) => (
                      <NoteRow
                        key={note.id}
                        note={note}
                        onSave={(text) =>
                          change(() =>
                            saveAgentMemoryNote(profileId, note.id, text),
                          )
                        }
                        onDelete={() =>
                          void change(() =>
                            deleteAgentMemoryNote(profileId, note.id),
                          )
                        }
                      />
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex flex-col gap-1.5 px-2">
                <div className="flex items-center gap-2">
                  <AnimatedSwitch
                    id={`${formId}-history`}
                    checked={memory.useHistory}
                    disabled={busy}
                    data-slot="agent-history-switch"
                    onCheckedChange={(checked) =>
                      void change(() => setAgentHistoryUse(profileId, checked))
                    }
                  />
                  <Label htmlFor={`${formId}-history`} className="text-sm">
                    {t("agent.memory.useHistory")}
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  {memory.useHistory && sites && sites.length > 0
                    ? t("agent.memory.historySites", {
                        sites: sites
                          .slice(0, SITES_SHOWN)
                          .map((site) => site.host)
                          .join(", "),
                      })
                    : t("agent.memory.historyHint")}
                </p>
              </div>
            </>
          )}
        </div>
      </FadingScrollArea>
    </section>
  );
}
