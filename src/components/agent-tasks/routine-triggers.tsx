import type { TFunction } from "i18next";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCopy, LuRefreshCw, LuTrash2 } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type AgentSubscription,
  createAgentSubscription,
  deleteAgentRoutineHook,
  deleteAgentSubscription,
  isHttpsUrl,
  isSlackUrl,
  listAgentSubscriptions,
  SUBSCRIPTION_EVENTS,
  type SubscriptionEvent,
  setAgentRoutineHook,
  testAgentSubscription,
} from "@/lib/agent-integrations";
import type { AgentRoutine, AgentRoutineHook } from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";

const SECTION_LABEL = "px-2 text-xs font-medium text-muted-foreground";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function copyText(text: string, t: TFunction) {
  try {
    await navigator.clipboard.writeText(text);
    showSuccessToast(t("agent.triggers.copied"));
  } catch (error) {
    showErrorToast(translateBackendError(t, error));
  }
}

/** The routine's webhook: make it, copy it, give it a new address, drop it. */
function Webhook({
  routine,
  onHook,
}: {
  routine: AgentRoutine;
  onHook: (hook: AgentRoutineHook | null) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setBusy(false);
    }
  };
  const make = () =>
    act(async () => {
      onHook(await setAgentRoutineHook(routine.id));
    });
  if (!routine.hook) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2">
        <span className="text-xs text-muted-foreground">
          {t("agent.triggers.hookHint")}
        </span>
        <Button
          type="button"
          variant="soft"
          size="sm"
          disabled={busy}
          data-slot="agent-hook-create"
          className="h-7 rounded-lg text-xs"
          onClick={() => void make()}
        >
          {t("agent.triggers.hookCreate")}
        </Button>
      </div>
    );
  }
  const url = routine.hook.url;
  return (
    <div className="flex flex-col gap-1 px-2">
      <div className="flex min-w-0 items-center gap-1">
        <code
          data-slot="agent-hook-url"
          className="min-w-0 flex-1 truncate rounded-lg bg-foreground/5 px-2.5 py-1.5 font-mono text-xs"
        >
          {url}
        </code>
        <Button
          type="button"
          variant="subtle"
          size="sm"
          aria-label={t("agent.triggers.copy")}
          title={t("agent.triggers.copy")}
          data-slot="agent-hook-copy"
          className="size-8 rounded-lg p-0"
          onClick={() => void copyText(url, t)}
        >
          <LuCopy className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="subtle"
          size="sm"
          disabled={busy}
          aria-label={t("agent.triggers.hookRotate")}
          title={t("agent.triggers.hookRotate")}
          data-slot="agent-hook-rotate"
          className="size-8 rounded-lg p-0"
          onClick={() => void make()}
        >
          <LuRefreshCw className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="subtle"
          size="sm"
          disabled={busy}
          aria-label={t("agent.triggers.hookDelete")}
          title={t("agent.triggers.hookDelete")}
          data-slot="agent-hook-delete"
          className="size-8 rounded-lg p-0 hover:bg-destructive/10 hover:text-destructive-text"
          onClick={() =>
            void act(async () => {
              await deleteAgentRoutineHook(routine.id);
              onHook(null);
            })
          }
        >
          <LuTrash2 className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      <span className="text-xs text-muted-foreground">
        {t("agent.triggers.hookUse")}
      </span>
    </div>
  );
}

/** Where the routine's results go: Slack or any webhook, per event. */
function Deliveries({ routineId }: { routineId: string }) {
  const { t } = useTranslation();
  const formId = useId();
  const [list, setList] = useState<AgentSubscription[] | null>(null);
  const [url, setUrl] = useState("");
  const [event, setEvent] = useState<SubscriptionEvent>("run.finished");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAgentSubscriptions()
      .then((all) => {
        if (!cancelled) setList(all);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setList([]);
          showErrorToast(translateBackendError(t, error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const mine = (list ?? []).filter((item) => item.routineId === routineId);
  const valid = isHttpsUrl(url);

  const add = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const saved = await createAgentSubscription({
        event,
        url: url.trim(),
        routineId,
      });
      setList((current) => [
        ...(current ?? []),
        { ...saved, secret: undefined },
      ]);
      setSecret(saved.secret ?? null);
      setUrl("");
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setBusy(false);
    }
  };

  const test = async (id: string) => {
    try {
      const tested = await testAgentSubscription(id);
      setList((current) =>
        (current ?? []).map((item) => (item.id === id ? tested : item)),
      );
      if (tested.lastError) {
        showErrorToast(
          t("agent.triggers.testFailed", { error: tested.lastError }),
        );
      } else {
        showSuccessToast(t("agent.triggers.testSent"));
      }
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteAgentSubscription(id);
      setList((current) => (current ?? []).filter((item) => item.id !== id));
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    }
  };

  return (
    <div className="flex flex-col gap-1.5 px-2">
      {mine.length > 0 && (
        <ul data-slot="agent-subscriptions" className="flex flex-col">
          {mine.map((item) => (
            <li
              key={item.id}
              data-slot="agent-subscription"
              data-event={item.event}
              className="group/sub flex min-h-8 items-center gap-2 text-xs"
            >
              <span className="w-28 shrink-0 text-muted-foreground">
                {t(`agent.triggers.events.${item.event}`)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {isSlackUrl(item.url)
                  ? t("agent.triggers.slack")
                  : hostOf(item.url)}
              </span>
              {item.lastError && (
                <span
                  title={item.lastError}
                  className="max-w-40 truncate text-destructive-text"
                >
                  {t("agent.triggers.failed")}
                </span>
              )}
              <Button
                type="button"
                variant="subtle"
                size="sm"
                data-slot="agent-subscription-test"
                className="h-7 rounded-lg px-2 text-xs opacity-0 group-hover/sub:opacity-100 focus-visible:opacity-100"
                onClick={() => void test(item.id)}
              >
                {t("agent.triggers.test")}
              </Button>
              <Button
                type="button"
                variant="subtle"
                size="sm"
                aria-label={t("agent.triggers.remove")}
                title={t("agent.triggers.remove")}
                className="size-7 rounded-lg p-0 opacity-0 group-hover/sub:opacity-100 focus-visible:opacity-100"
                onClick={() => void remove(item.id)}
              >
                <LuTrash2 className="size-3.5" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(submit) => {
          submit.preventDefault();
          void add();
        }}
      >
        <Label htmlFor={`${formId}-url`} className="sr-only">
          {t("agent.triggers.url")}
        </Label>
        <Input
          id={`${formId}-url`}
          value={url}
          inputMode="url"
          placeholder={t("agent.triggers.urlPlaceholder")}
          aria-invalid={url.trim() !== "" && !valid}
          data-slot="agent-subscription-url"
          className="h-8 min-w-48 flex-1 text-xs md:text-xs"
          onChange={(change) => {
            setUrl(change.target.value);
          }}
        />
        <Select
          value={event}
          onValueChange={(next) => {
            setEvent(next as SubscriptionEvent);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={t("agent.triggers.event")}
            data-slot="agent-subscription-event"
            className="h-8 w-40 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUBSCRIPTION_EVENTS.map((item) => (
              <SelectItem key={item} value={item} className="text-xs">
                {t(`agent.triggers.events.${item}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="submit"
          variant="soft"
          size="sm"
          disabled={!valid || busy}
          data-slot="agent-subscription-add"
          className="h-8 rounded-lg text-xs"
        >
          {t("agent.triggers.add")}
        </Button>
      </form>
      {secret && (
        <div
          data-slot="agent-subscription-secret"
          className="flex min-w-0 items-center gap-2 text-xs"
        >
          <span className="shrink-0 text-muted-foreground">
            {t("agent.triggers.secret")}
          </span>
          <code className="min-w-0 truncate font-mono">{secret}</code>
          <Button
            type="button"
            variant="subtle"
            size="sm"
            aria-label={t("agent.triggers.copy")}
            title={t("agent.triggers.copy")}
            className="size-7 shrink-0 rounded-lg p-0"
            onClick={() => void copyText(secret, t)}
          >
            <LuCopy className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}

/** What starts a routine besides its schedule, and where its results go. */
export function RoutineTriggers({
  routine,
  onHook,
}: {
  routine: AgentRoutine;
  onHook: (hook: AgentRoutineHook | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div data-slot="agent-routine-triggers" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className={SECTION_LABEL}>{t("agent.triggers.webhook")}</span>
        <Webhook routine={routine} onHook={onHook} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className={SECTION_LABEL}>{t("agent.triggers.sendTo")}</span>
        <Deliveries routineId={routine.id} />
      </div>
    </div>
  );
}
