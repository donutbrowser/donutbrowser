import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCopy, LuDownload } from "react-icons/lu";
import { StateDot } from "@/components/agent-tasks/parts";
import { DATA_TABLE_CLASSES } from "@/components/table-controls";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type AgentRoutineRun,
  type AgentTable,
  cellText,
  exportAgentRoutineTable,
  getAgentRoutineTable,
  tableTsv,
} from "@/lib/agent-tasks";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";

/**
 * One batch of a routine with columns, as a table: a row per profile, a
 * column per value, and the run's result last. Copies as rows a spreadsheet
 * takes, or saves as CSV.
 */
export function RoutineTable({
  routineId,
  batchId,
  runs,
  profileNames,
}: {
  routineId: string;
  batchId: string;
  runs: AgentRoutineRun[];
  profileNames: Map<string, string>;
}) {
  const { t } = useTranslation();
  const [table, setTable] = useState<AgentTable | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);
  // Read again as runs of the batch finish.
  const finished = runs.filter((run) => run.finishedAt).length;

  useEffect(() => {
    if (finished < 0) return;
    let cancelled = false;
    getAgentRoutineTable(routineId, batchId)
      .then((next) => {
        if (!cancelled) {
          setTable(next);
          setError(null);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError);
      });
    return () => {
      cancelled = true;
    };
  }, [routineId, batchId, finished]);

  const nameOf = (profileId: string | null) =>
    (profileId && profileNames.get(profileId)) ??
    t("agent.tasks.unknownProfile");
  const summaries = new Map(runs.map((run) => [run.runId, run.summary]));

  if (error !== null) {
    return (
      <p className="px-2 text-xs text-destructive-text">
        {translateBackendError(t, error)}
      </p>
    );
  }
  if (!table) return <Skeleton className="h-16 w-full" />;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tableTsv(table, nameOf));
      showSuccessToast(t("agent.output.copied"));
    } catch (copyError) {
      showErrorToast(translateBackendError(t, copyError));
    }
  };

  const exportCsv = async () => {
    const path = await save({
      defaultPath: `routine-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    setExporting(true);
    try {
      const rows = await exportAgentRoutineTable(routineId, batchId, path);
      showSuccessToast(t("agent.output.exported", { count: rows }));
    } catch (exportError) {
      showErrorToast(translateBackendError(t, exportError));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div data-slot="agent-routine-table" className="flex flex-col gap-1">
      <div className="flex items-center justify-end gap-1">
        <Button
          type="button"
          variant="subtle"
          size="sm"
          data-slot="agent-table-copy"
          className="h-7 gap-1.5 rounded-lg px-2 text-xs"
          onClick={() => void copy()}
        >
          <LuCopy className="size-3.5" aria-hidden="true" />
          {t("agent.output.copy")}
        </Button>
        <Button
          type="button"
          variant="subtle"
          size="sm"
          data-slot="agent-table-export"
          disabled={exporting}
          aria-busy={exporting}
          className="h-7 gap-1.5 rounded-lg px-2 text-xs"
          onClick={() => void exportCsv()}
        >
          <LuDownload className="size-3.5" aria-hidden="true" />
          {t("agent.output.export")}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <Table className={cn(DATA_TABLE_CLASSES.table, "min-w-full text-xs")}>
          <TableHeader className={DATA_TABLE_CLASSES.header}>
            <TableRow className={DATA_TABLE_CLASSES.headerRow}>
              <TableHead className={cn(DATA_TABLE_CLASSES.head, "w-36")}>
                {t("agent.output.profile")}
              </TableHead>
              {table.columns.map((column) => (
                <TableHead
                  key={column.name}
                  className={cn(DATA_TABLE_CLASSES.head, "w-28")}
                >
                  {column.name}
                </TableHead>
              ))}
              <TableHead className={cn(DATA_TABLE_CLASSES.head, "w-48")}>
                {t("agent.output.result")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {table.rows.map((row) => {
              const summary = summaries.get(row.runId) ?? "";
              return (
                <TableRow
                  key={row.runId}
                  data-slot="agent-table-row"
                  className={DATA_TABLE_CLASSES.row}
                >
                  <TableCell className={cn(DATA_TABLE_CLASSES.cell, "h-8")}>
                    <span className="flex min-w-0 items-center gap-2">
                      <StateDot status={row.status} className="size-1.5" />
                      <span className="truncate">{nameOf(row.profileId)}</span>
                    </span>
                  </TableCell>
                  {table.columns.map((column) => (
                    <TableCell
                      key={column.name}
                      data-column={column.name}
                      className={cn(
                        DATA_TABLE_CLASSES.cell,
                        "truncate",
                        column.type === "number" && "tabular-nums",
                      )}
                    >
                      {column.type === "bool" &&
                      typeof row.data[column.name] === "boolean"
                        ? t(
                            row.data[column.name]
                              ? "agent.output.yes"
                              : "agent.output.no",
                          )
                        : cellText(row.data[column.name])}
                    </TableCell>
                  ))}
                  <TableCell
                    title={summary}
                    className={cn(
                      DATA_TABLE_CLASSES.cell,
                      "truncate text-muted-foreground",
                    )}
                  >
                    {summary.split("\n")[0]}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
