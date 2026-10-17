import { matchRanges } from "@/lib/palette-search";

/** `text` with the parts the search matched tinted. */
export function MatchText({
  text,
  search,
  className,
}: {
  text: string;
  search: string;
  className?: string;
}) {
  const ranges = matchRanges(text, search);
  if (ranges.length === 0) return <span className={className}>{text}</span>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={start} className="rounded-[3px] bg-primary/15 text-foreground">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <span className={className}>{parts}</span>;
}
