/** A column that may leave the table when the name column needs the room. */
export interface FitColumn {
  id: string;
  /** Narrowest useful width in px. */
  floor: number;
  /** Share of the container width the column takes when there is room. */
  pct: number;
  /**
   * Width its content needs. When set, it replaces `pct`: the column takes
   * this much before the name grows.
   */
  want?: number;
  /** The person chose to show it: it stays, whatever the width. */
  pinned?: boolean;
}

export interface ColumnFit {
  visible: Record<string, boolean>;
  widths: Record<string, number>;
  /** What the name column keeps, in px. */
  nameWidth: number;
}

/**
 * Fits the optional columns around the name column. Columns first shrink
 * from their proportional width toward their floor; when the name would
 * still keep less than `minName`, they leave in the given order (most
 * expendable first) until it keeps at least that much. A column with
 * `want` keeps its content width: others leave before it shrinks.
 */
export function fitColumns(
  containerWidth: number,
  fixedWidth: number,
  columns: FitColumn[],
  minName: number,
): ColumnFit {
  const shown = columns.slice();
  const hidden = new Set<string>();
  const proportional = (column: FitColumn) =>
    Math.max(
      column.floor,
      column.want ?? Math.round(containerWidth * column.pct),
    );
  // A column sized to its content needs all of it; others need their floor.
  const need = (column: FitColumn) =>
    column.want === undefined ? column.floor : proportional(column);
  for (;;) {
    const floors = shown.reduce((sum, column) => sum + column.floor, 0);
    const room = containerWidth - fixedWidth - minName - floors;
    const short =
      containerWidth -
      fixedWidth -
      minName -
      shown.reduce((sum, column) => sum + need(column), 0);
    const removable = shown.findIndex((column) => !column.pinned);
    if (short >= 0 || removable < 0) {
      const grow = (list: FitColumn[]) =>
        list.reduce(
          (sum, column) => sum + proportional(column) - column.floor,
          0,
        );
      // A column that left may come back, most important first, when it
      // fits whole in what the others leave at full width: a narrow one
      // after a wide one left.
      let free = room;
      let spare = room - grow(shown);
      for (const column of columns.slice().reverse()) {
        const width = proportional(column);
        if (!hidden.has(column.id) || width > spare) continue;
        hidden.delete(column.id);
        shown.push(column);
        spare -= width;
        free -= column.floor;
      }
      const growth = grow(shown);
      const share = growth > 0 ? Math.min(1, Math.max(0, free) / growth) : 0;
      const widths: Record<string, number> = {};
      for (const column of shown) {
        widths[column.id] = Math.round(
          column.floor + (proportional(column) - column.floor) * share,
        );
      }
      const visible: Record<string, boolean> = {};
      for (const column of columns) visible[column.id] = !hidden.has(column.id);
      const used = Object.values(widths).reduce((sum, width) => sum + width, 0);
      return {
        visible,
        widths,
        nameWidth: containerWidth - fixedWidth - used,
      };
    }
    hidden.add(shown[removable].id);
    shown.splice(removable, 1);
  }
}
