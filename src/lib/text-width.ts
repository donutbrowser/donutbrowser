let context: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

function family(kind: "sans" | "mono"): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--font-${kind}`)
    .trim();
  return value || (kind === "mono" ? "monospace" : "sans-serif");
}

/** Width in px of `text` at `size` px in the app's sans or mono font. */
export function textWidth(
  text: string,
  size: number,
  kind: "sans" | "mono" = "sans",
  weight = 400,
): number {
  if (typeof document === "undefined") return 0;
  const font = `${weight} ${size}px ${family(kind)}`;
  const key = `${font}\n${text}`;
  const cached = widths.get(key);
  if (cached !== undefined) return cached;
  if (context === undefined)
    context = document.createElement("canvas").getContext("2d");
  if (!context) return 0;
  context.font = font;
  const width = Math.ceil(context.measureText(text).width);
  if (widths.size > 2000) widths.clear();
  widths.set(key, width);
  return width;
}

/**
 * The width a column needs to show its longest value whole: the text plus
 * `chrome` (padding, icons), between `min` and `max`. `min` when every value
 * is empty.
 */
export function contentColumnWidth(
  texts: readonly string[],
  {
    size = 14,
    kind = "sans",
    chrome,
    min,
    max,
  }: {
    size?: number;
    kind?: "sans" | "mono";
    chrome: number;
    min: number;
    max: number;
  },
): number {
  let longest = 0;
  for (const text of new Set(texts)) {
    if (text) longest = Math.max(longest, textWidth(text, size, kind));
  }
  if (longest === 0) return min;
  return Math.min(max, Math.max(min, longest + chrome));
}
