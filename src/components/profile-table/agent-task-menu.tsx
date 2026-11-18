"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { LuMessageSquarePlus, LuRepeat, LuSparkles } from "react-icons/lu";
import { DataTableActionBarAction } from "@/components/data-table-action-bar";
import type { AgentSource } from "@/components/profile-table/agent-activity";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type AgentRoutine,
  listAgentRoutines,
  runAgentRoutine,
} from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";

/**
 * The action bar's agent menu: a new task on the selection, or one of the
 * saved routines run on it. The routines are read from the cloud when the
 * menu opens, never before.
 */
export function AgentTaskMenu({
  profileIds,
  onNewTask,
  onOpen,
}: {
  profileIds: string[];
  onNewTask: () => void;
  onOpen?: (source: AgentSource) => void;
}) {
  const { t } = useTranslation();
  const [routines, setRoutines] = React.useState<AgentRoutine[] | null>(null);

  const load = () => {
    listAgentRoutines()
      .then(setRoutines)
      .catch((error: unknown) => {
        console.warn("Failed to list agent routines:", error);
        setRoutines([]);
      });
  };

  const run = (routine: AgentRoutine) => {
    runAgentRoutine(routine.id, profileIds)
      .then((batch) => {
        showSuccessToast(
          t("agent.chat.host.started", { count: batch.tasks.length }),
          {
            description: routine.name,
            ...(onOpen
              ? {
                  action: {
                    label: t("profileTable.agent.openRun"),
                    onClick: () => onOpen({ kind: "run", id: batch.id }),
                  },
                }
              : {}),
          },
        );
      })
      .catch((error: unknown) => {
        showErrorToast(translateBackendError(t, error));
      });
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) load();
      }}
    >
      <DropdownMenuTrigger asChild>
        <DataTableActionBarAction
          data-bulk-action="agent-task"
          label={t("profileTable.agent.header")}
        >
          <LuSparkles />
        </DataTableActionBarAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem data-slot="agent-task-new" onSelect={onNewTask}>
          <LuMessageSquarePlus />
          {t("profiles.actionBar.runTask")}
        </DropdownMenuItem>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("agent.chat.routines")}
        </DropdownMenuLabel>
        {routines === null ? (
          <DropdownMenuItem disabled>
            {t("profileTable.agent.loadingRoutines")}
          </DropdownMenuItem>
        ) : routines.length === 0 ? (
          <DropdownMenuItem disabled data-slot="agent-task-no-routines">
            {t("profileTable.agent.noRoutines")}
          </DropdownMenuItem>
        ) : (
          routines.map((routine) => (
            <DropdownMenuItem
              key={routine.id}
              data-slot="agent-task-routine"
              data-routine-id={routine.id}
              onSelect={() => run(routine)}
            >
              <LuRepeat />
              <span className="truncate">{routine.name}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
