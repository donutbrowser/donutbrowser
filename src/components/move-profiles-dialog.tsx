"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingButton } from "@/components/loading-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { paletteScore } from "@/lib/palette-search";
import type { BrowserProfile } from "@/types";

interface MoveProfilesDialogProps {
  /** The group the profiles move into; null closes the dialog. */
  group: { id: string; name: string } | null;
  onClose: () => void;
  profiles: BrowserProfile[];
  runningProfiles: Set<string>;
  /** Resolves true when the move landed. */
  onMove: (profileIds: string[], groupId: string) => Promise<boolean>;
}

/** Picks profiles from other groups and moves them into one group. */
export function MoveProfilesDialog({
  group,
  onClose,
  profiles,
  runningProfiles,
  onMove,
}: MoveProfilesDialogProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState(false);

  const candidates = useMemo(
    () =>
      group
        ? profiles
            .filter((profile) => profile.group_id !== group.id)
            .filter((profile) => paletteScore(profile.name, [], search) > 0)
        : [],
    [group, profiles, search],
  );

  const close = () => {
    setSearch("");
    setPicked(new Set());
    onClose();
  };

  const toggle = (id: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const move = async () => {
    if (!group || picked.size === 0) return;
    setMoving(true);
    try {
      if (await onMove([...picked], group.id)) close();
    } finally {
      setMoving(false);
    }
  };

  return (
    <Dialog
      open={group !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="flex max-h-[min(36rem,calc(100vh-3rem))] flex-col sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("moveProfiles.title", { group: group?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>{t("moveProfiles.description")}</DialogDescription>
        </DialogHeader>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("header.searchPlaceholder")}
          aria-label={t("header.searchPlaceholder")}
        />
        <ul
          data-slot="move-profiles-list"
          className="-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          {candidates.length === 0 && (
            <li className="px-2 py-6 text-center text-sm text-muted-foreground">
              {search ? t("common.noResults") : t("moveProfiles.empty")}
            </li>
          )}
          {candidates.map((profile) => {
            const running = runningProfiles.has(profile.id);
            const id = `move-profile-${profile.id}`;
            return (
              <li key={profile.id}>
                <label
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-foreground/5 has-disabled:cursor-not-allowed has-disabled:opacity-60"
                >
                  <Checkbox
                    id={id}
                    checked={picked.has(profile.id)}
                    disabled={running}
                    onCheckedChange={() => toggle(profile.id)}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {profile.name}
                  </span>
                  {running && (
                    <span className="text-xs text-muted-foreground">
                      {t("common.status.running")}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button variant="subtle" onClick={close}>
            {t("common.buttons.cancel")}
          </Button>
          <LoadingButton
            isLoading={moving}
            disabled={picked.size === 0}
            onClick={() => void move()}
          >
            {t("moveProfiles.confirm", { count: picked.size })}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
