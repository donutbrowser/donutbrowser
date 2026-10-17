/**
 * Search and recent commands for the command palette and the shortcuts page.
 *
 * Kept free of runtime imports so `palette-search.test.mjs` can load it
 * directly.
 */

/** How many recent commands are kept, and how many the palette shows. */
export const RECENT_STORED = 8;
export const RECENT_SHOWN = 5;

export function searchTokens(search: string): string[] {
  return search.toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function isWordStart(text: string, index: number) {
  return index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1]);
}

/** Where `token` occurs in `text`, preferring the start of a word. */
function bestIndex(text: string, token: string) {
  let first = -1;
  let from = 0;
  for (;;) {
    const index = text.indexOf(token, from);
    if (index === -1) return first;
    if (isWordStart(text, index)) return index;
    if (first === -1) first = index;
    from = index + 1;
  }
}

/**
 * Every token of the query must appear in the label or in a keyword, in any
 * order. A token at the start of a word scores higher than one inside a word,
 * and the label counts more than the keywords, so "set" ranks "Go to
 * Settings" above a command that only lists "settings" as a synonym.
 * Returns 0 when a token is missing.
 */
export function paletteScore(
  label: string,
  keywords: readonly string[],
  search: string,
): number {
  const tokens = searchTokens(search);
  if (tokens.length === 0) return 1;
  const name = label.toLocaleLowerCase();
  const extra = keywords.join(" ").toLocaleLowerCase();
  let score = 0;
  for (const token of tokens) {
    const inName = bestIndex(name, token);
    if (inName !== -1) {
      score += (isWordStart(name, inName) ? 1 : 0.6) / (1 + inName / 40);
      continue;
    }
    const inExtra = bestIndex(extra, token);
    if (inExtra === -1) return 0;
    score += isWordStart(extra, inExtra) ? 0.4 : 0.25;
  }
  return score / tokens.length;
}

/**
 * The parts of `label` the query matched, as sorted, merged [start, end)
 * ranges. Empty when lower-casing changes the label's length, because the
 * ranges would not line up with the text on screen.
 */
export function matchRanges(
  label: string,
  search: string,
): Array<[number, number]> {
  const name = label.toLocaleLowerCase();
  if (name.length !== label.length) return [];
  const ranges: Array<[number, number]> = [];
  for (const token of searchTokens(search)) {
    const index = bestIndex(name, token);
    if (index !== -1) ranges.push([index, index + token.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** Puts `id` first, without duplicates, keeping at most `RECENT_STORED`. */
export function rememberRecent(list: readonly string[], id: string): string[] {
  return [id, ...list.filter((entry) => entry !== id)].slice(0, RECENT_STORED);
}

/** Reads the stored list; anything malformed is an empty list. */
export function parseRecents(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .slice(0, RECENT_STORED);
  } catch {
    return [];
  }
}
