const AGO_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3600],
  ["minute", 60],
];

/** "3 hours ago" in the given language. Both times are Unix seconds. */
export function formatTimeAgo(
  at: number,
  now: number,
  language: string,
): string {
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const seconds = at - now;
  for (const [unit, size] of AGO_UNITS) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(Math.trunc(seconds / size), unit);
    }
  }
  return formatter.format(0, "second");
}

/** "2 hr, 5 min" in the given language, to the minute. */
export function formatDuration(seconds: number, language: string): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const unit = (value: number, name: "day" | "hour" | "minute") =>
    new Intl.NumberFormat(language, {
      style: "unit",
      unit: name,
      unitDisplay: "short",
    }).format(value);
  const parts =
    days > 0
      ? [unit(days, "day"), ...(hours > 0 ? [unit(hours, "hour")] : [])]
      : hours > 0
        ? [
            unit(hours, "hour"),
            ...(minutes > 0 ? [unit(minutes, "minute")] : []),
          ]
        : [unit(minutes, "minute")];
  return new Intl.ListFormat(language, { type: "unit", style: "short" }).format(
    parts,
  );
}
