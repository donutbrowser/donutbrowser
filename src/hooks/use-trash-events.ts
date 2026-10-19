import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { translateBackendError } from "@/lib/backend-errors";
import {
  showErrorToast,
  showSuccessToast,
  showUndoToast,
} from "@/lib/toast-utils";
import type {
  RestoredEntity,
  TrashEntityKind,
  TrashedEntitySummary,
  TrashedProfileSummary,
} from "@/types";

/**
 * The trash as the backend reports it: deleted profiles and the other
 * entities, kept current by the `trash-changed` event every trash mutation
 * (delete, restore, purge, expiry sweep) emits.
 */
export function useTrashEvents() {
  const [profiles, setProfiles] = useState<TrashedProfileSummary[]>([]);
  const [entities, setEntities] = useState<TrashedEntitySummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    try {
      const [listedProfiles, listedEntities] = await Promise.all([
        invoke<TrashedProfileSummary[]>("list_trashed_profiles"),
        invoke<TrashedEntitySummary[]>("list_trashed_entities"),
      ]);
      setProfiles(listedProfiles);
      setEntities(listedEntities);
      setError(null);
    } catch (err: unknown) {
      console.error("Failed to load trash:", err);
      setError(
        i18n.t("trash.loadFailed", {
          error: translateBackendError(i18n.t, err),
        }),
      );
    }
  }, []);

  useEffect(() => {
    let trashUnlisten: (() => void) | undefined;
    let cancelled = false;

    const setupListeners = async () => {
      try {
        await loadEntries();
        const unlisten = await listen("trash-changed", () => {
          void loadEntries();
        });
        // The effect may already be torn down by the time listen() resolves.
        if (cancelled) {
          unlisten();
        } else {
          trashUnlisten = unlisten;
        }
      } catch (err) {
        console.error("Failed to set up trash event listener:", err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void setupListeners();

    return () => {
      cancelled = true;
      if (trashUnlisten) trashUnlisten();
    };
  }, [loadEntries]);

  return { profiles, entities, isLoading, error, reload: loadEntries };
}

export interface TrashTarget {
  id: string;
  name: string;
}

/** "Delete at once" is on: a delete is for good, so it asks first. */
async function trashIsOff(): Promise<boolean> {
  try {
    const settings = await invoke<{ trash_retention_days?: number }>(
      "get_app_settings",
    );
    return settings.trash_retention_days === 0;
  } catch {
    return false;
  }
}

/** Bring entities back from the trash, and say how it went. */
export async function restoreEntities(
  kind: TrashEntityKind,
  items: TrashTarget[],
): Promise<RestoredEntity[]> {
  const t = i18n.t;
  const results = await Promise.allSettled(
    items.map((item) =>
      invoke<RestoredEntity>("restore_trashed_entity", { kind, id: item.id }),
    ),
  );
  const restored = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    showErrorToast(
      t("trash.restoreFailed", {
        error: translateBackendError(t, failure.reason),
      }),
    );
  }
  if (restored.length > 0) {
    const syncStayedOff = restored.some((entity) => entity.sync_stayed_off);
    showSuccessToast(
      restored.length === 1
        ? t("trash.restored", { name: restored[0].name })
        : t("trash.restoredMany", { count: restored.length }),
      {
        description: syncStayedOff
          ? t("trash.restoredSyncOffEntity")
          : undefined,
        duration: syncStayedOff ? 10000 : undefined,
        sound: "restore",
      },
    );
  }
  return restored;
}

/**
 * Delete proxies, VPNs, groups, extensions, extension groups or templates the
 * way the app deletes: to the trash, with no question, and an Undo in the
 * toast.
 *
 * `request` asks first only when the trash is off ("Delete at once"): it then
 * calls `confirm` and does nothing else, and the confirmation calls `remove`.
 * Both resolve to the ids that left the list.
 */
export function useEntityTrash(kind: TrashEntityKind) {
  const { t } = useTranslation();

  const remove = useCallback(
    async (items: TrashTarget[]): Promise<string[]> => {
      if (items.length === 0) return [];
      const results = await Promise.allSettled(
        items.map((item) =>
          invoke<{ trashed: boolean }>("trash_entity", { kind, id: item.id }),
        ),
      );
      const trashed: TrashTarget[] = [];
      const erased: TrashTarget[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          (result.value.trashed ? trashed : erased).push(items[index]);
        }
      });
      const failedIndex = results.findIndex(
        (result) => result.status === "rejected",
      );
      if (failedIndex >= 0) {
        const failure = results[failedIndex] as PromiseRejectedResult;
        showErrorToast(
          t("trash.deleteFailed", {
            name: items[failedIndex].name,
            error: translateBackendError(t, failure.reason),
          }),
        );
      }
      if (trashed.length > 0) {
        showUndoToast(
          trashed.length === 1
            ? t("trash.moved", { name: trashed[0].name })
            : t("trash.movedMany", { count: trashed.length }),
          async () => {
            await restoreEntities(kind, trashed);
          },
        );
      } else if (erased.length > 0) {
        showSuccessToast(
          erased.length === 1
            ? t("trash.deleted", { name: erased[0].name })
            : t("trash.deletedMany", { count: erased.length }),
          { sound: "trash" },
        );
      }
      return [...trashed, ...erased].map((item) => item.id);
    },
    [kind, t],
  );

  const request = useCallback(
    async (items: TrashTarget[], confirm: () => void): Promise<string[]> => {
      if (await trashIsOff()) {
        confirm();
        return [];
      }
      return remove(items);
    },
    [remove],
  );

  return { request, remove };
}
