"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuBookOpen, LuCheck } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAgentPlaybooks } from "@/hooks/use-agent-playbooks";
import { MAX_PICKED_PLAYBOOKS } from "@/lib/agent-playbooks";
import { cn } from "@/lib/utils";

/**
 * The playbooks a routine always gets. The ones written for its site come
 * without being picked.
 */
export function PlaybookPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { playbooks } = useAgentPlaybooks(open || selected.length > 0);
  const chosen = new Set(selected);
  const known = (playbooks ?? []).filter((playbook) => chosen.has(playbook.id));
  const label =
    known.length === 0
      ? t("agent.playbooks.pick")
      : known.length === 1
        ? known[0].name
        : t("agent.playbooks.count", { count: known.length });
  const toggle = (id: string) => {
    if (chosen.has(id)) {
      onChange(selected.filter((item) => item !== id));
    } else if (selected.length < MAX_PICKED_PLAYBOOKS) {
      onChange([...selected, id]);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="soft"
          size="sm"
          data-slot="agent-playbook-picker"
          className="h-8 max-w-48 gap-1.5 rounded-xl text-xs"
        >
          <LuBookOpen className="size-3.5" aria-hidden="true" />
          <span className="min-w-0 truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder={t("agent.playbooks.search")} />
          <CommandList className="max-h-64">
            <CommandEmpty>
              {playbooks?.length === 0
                ? t("agent.playbooks.none")
                : t("agent.playbooks.noMatch")}
            </CommandEmpty>
            <CommandGroup>
              {(playbooks ?? []).map((playbook) => (
                <CommandItem
                  key={playbook.id}
                  value={`${playbook.name} ${playbook.sites.join(" ")} ${playbook.id}`}
                  data-slot="agent-playbook-option"
                  data-playbook-id={playbook.id}
                  onSelect={() => {
                    toggle(playbook.id);
                  }}
                >
                  <LuCheck
                    className={cn(
                      "size-3.5",
                      chosen.has(playbook.id) ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {playbook.name}
                  </span>
                  {playbook.sites[0] && (
                    <span className="truncate text-xs text-muted-foreground">
                      {playbook.sites[0]}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        <p className="px-3 pt-1 pb-2.5 text-xs text-muted-foreground">
          {t("agent.playbooks.bySite")}
        </p>
      </PopoverContent>
    </Popover>
  );
}
