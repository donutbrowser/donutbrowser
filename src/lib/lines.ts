/** One item per line, as the list fields (start pages, bypass rules) show and take them. */
export function linesFromText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
