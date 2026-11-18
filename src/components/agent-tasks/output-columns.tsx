import { useId } from "react";
import { useTranslation } from "react-i18next";
import { LuPlus, LuX } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AGENT_COLUMN_TYPES,
  type AgentColumn,
  type AgentColumnType,
  MAX_COLUMNS,
} from "@/lib/agent-tasks";

/** Whether the columns can be saved: each named, each name once. */
export function columnsInvalid(columns: AgentColumn[]): boolean {
  const names = columns.map((column) => column.name.trim().toLowerCase());
  return names.some(
    (name, index) => name === "" || names.indexOf(name) !== index,
  );
}

/**
 * The values each run of a routine ends with, as named columns. The runs of
 * one batch read back as a table.
 */
export function OutputColumns({
  columns,
  onChange,
}: {
  columns: AgentColumn[];
  onChange: (columns: AgentColumn[]) => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const set = (index: number, patch: Partial<AgentColumn>) => {
    onChange(
      columns.map((column, at) =>
        at === index ? { ...column, ...patch } : column,
      ),
    );
  };
  const add = (
    <Button
      type="button"
      variant="subtle"
      size="sm"
      data-slot="agent-column-add"
      disabled={columns.length >= MAX_COLUMNS}
      className="h-7 w-fit gap-1.5 rounded-lg px-2 text-xs text-muted-foreground"
      onClick={() => {
        onChange([...columns, { name: "", type: "text" }]);
      }}
    >
      <LuPlus className="size-3.5" aria-hidden="true" />
      {t("agent.output.add")}
    </Button>
  );
  if (columns.length === 0) return add;
  return (
    <div data-slot="agent-columns" className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">
        {t("agent.output.hint")}
      </span>
      <ul className="flex flex-col gap-1.5">
        {columns.map((column, index) => (
          // Columns have no id of their own; their place is their identity.
          <li key={index} className="flex items-center gap-1.5">
            <label htmlFor={`${formId}-${index}`} className="sr-only">
              {t("agent.output.name")}
            </label>
            <Input
              id={`${formId}-${index}`}
              value={column.name}
              maxLength={60}
              placeholder={t("agent.output.namePlaceholder")}
              data-slot="agent-column-name"
              className="h-8 min-w-0 flex-1 text-xs md:text-xs"
              onChange={(event) => {
                set(index, { name: event.target.value });
              }}
            />
            <Select
              value={column.type}
              onValueChange={(next) => {
                set(index, { type: next as AgentColumnType });
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label={t("agent.output.type")}
                data-slot="agent-column-type"
                className="h-8 w-28 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_COLUMN_TYPES.map((type) => (
                  <SelectItem key={type} value={type} className="text-xs">
                    {t(`agent.output.types.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="subtle"
              size="sm"
              aria-label={t("agent.output.remove")}
              title={t("agent.output.remove")}
              className="size-8 rounded-lg p-0"
              onClick={() => {
                onChange(columns.filter((_, at) => at !== index));
              }}
            >
              <LuX className="size-3.5" aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      {add}
    </div>
  );
}
