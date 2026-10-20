/**
 * Where a coach mark can point. Each id is a `data-tip-anchor` attribute on a
 * real element; the coach mark looks the element up by it, so a component
 * becomes an anchor with one attribute and no wiring.
 */
export const COACH_ANCHORS = [
  "rail-profiles",
  "rail-proxies",
  "rail-extensions",
  "rail-groups",
  "rail-cookieBot",
  "rail-agent",
  "rail-integrations",
  "rail-account",
  "rail-more",
  "rail-settings",
  "profile-search",
  "new-profile",
  "group-strip",
  "column-state",
  "column-proxy",
  "column-ext",
  "column-dns",
  "row-dns",
  "row-inspect",
] as const;

export type CoachAnchorId = (typeof COACH_ANCHORS)[number];

/** The rail is always on screen, so a rail anchor is a safe last choice. */
export function isRailAnchor(id: CoachAnchorId): boolean {
  return id.startsWith("rail-");
}

export const ANCHOR_ATTRIBUTE = "data-tip-anchor";

/** A closing coach mark plays its exit this long; its owner unmounts it after. */
export const COACH_MARK_EXIT_MS = 180;

export function anchorSelector(id: CoachAnchorId): string {
  return `[${ANCHOR_ATTRIBUTE}="${id}"]`;
}

export type Side = "top" | "right" | "bottom" | "left";

/**
 * The attributes that make an element a coach-mark anchor, with the side its
 * card prefers. Typed, so an id the coach marks do not know fails to compile.
 */
export function tipAnchor(
  id: CoachAnchorId,
  side?: Side,
): Record<string, string> {
  return side
    ? { [ANCHOR_ATTRIBUTE]: id, "data-tip-side": side }
    : { [ANCHOR_ATTRIBUTE]: id };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  side: Side;
  x: number;
  y: number;
  /** Where the arrow meets the card, along the edge that faces the anchor. */
  arrow: number;
  /** False when no side had room and the card was pushed over the anchor. */
  fits: boolean;
}

const OPPOSITE: Record<Side, Side> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

const PERPENDICULAR: Record<Side, [Side, Side]> = {
  top: ["right", "left"],
  bottom: ["right", "left"],
  left: ["bottom", "top"],
  right: ["bottom", "top"],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** The room between the anchor and the edge of the area on one side. */
function room(anchor: Box, area: Box, side: Side): number {
  switch (side) {
    case "top":
      return anchor.y - area.y;
    case "bottom":
      return area.y + area.height - (anchor.y + anchor.height);
    case "left":
      return anchor.x - area.x;
    case "right":
      return area.x + area.width - (anchor.x + anchor.width);
  }
}

function toArea(area: Box | Size): Box {
  return "x" in area ? area : { x: 0, y: 0, ...area };
}

/**
 * Puts a card of `card` size next to `anchor`, `gap` away, inside `bounds`
 * (the viewport, or the part of a scroll container that shows) with `margin`
 * to spare. The preferred side wins when the card fits there; then the
 * opposite side, then the two others. Along the edge the card centers on the
 * anchor and slides to stay inside, and `arrow` keeps pointing at the
 * anchor's middle, never closer than `arrowInset` to a corner. A card that
 * fits never covers its anchor.
 */
export function placeCoachMark(
  anchor: Box,
  card: Size,
  bounds: Box | Size,
  {
    side: preferred = "bottom",
    gap = 12,
    margin = 8,
    arrowInset = 16,
  }: {
    side?: Side;
    gap?: number;
    margin?: number;
    arrowInset?: number;
  } = {},
): Placement {
  const area = toArea(bounds);
  const order: Side[] = [
    preferred,
    OPPOSITE[preferred],
    ...PERPENDICULAR[preferred],
  ];
  const needs = (side: Side) =>
    (side === "top" || side === "bottom" ? card.height : card.width) +
    gap +
    margin;
  const across = (side: Side) =>
    (side === "top" || side === "bottom" ? card.width : card.height) +
    margin * 2;
  const breadth = (side: Side) =>
    side === "top" || side === "bottom" ? area.width : area.height;
  const chosen =
    order.find(
      (side) =>
        room(anchor, area, side) >= needs(side) &&
        breadth(side) >= across(side),
    ) ?? null;
  const side =
    chosen ??
    order.reduce((best, side) =>
      room(anchor, area, side) - needs(side) >
      room(anchor, area, best) - needs(best)
        ? side
        : best,
    );

  const left = area.x + margin;
  const top = area.y + margin;
  const right = area.x + area.width - margin;
  const bottom = area.y + area.height - margin;
  const centerX = anchor.x + anchor.width / 2;
  const centerY = anchor.y + anchor.height / 2;
  let x: number;
  let y: number;
  if (side === "top" || side === "bottom") {
    x = clamp(centerX - card.width / 2, left, right - card.width);
    y =
      side === "bottom"
        ? anchor.y + anchor.height + gap
        : anchor.y - gap - card.height;
    y = clamp(y, top, bottom - card.height);
  } else {
    y = clamp(centerY - card.height / 2, top, bottom - card.height);
    x =
      side === "right"
        ? anchor.x + anchor.width + gap
        : anchor.x - gap - card.width;
    x = clamp(x, left, right - card.width);
  }

  const along = side === "top" || side === "bottom";
  const length = along ? card.width : card.height;
  const arrow = clamp(
    (along ? centerX - x : centerY - y) || length / 2,
    Math.min(arrowInset, length / 2),
    length - Math.min(arrowInset, length / 2),
  );
  return { side, x, y, arrow, fits: chosen !== null };
}

/**
 * The part of `box` that is not clipped by `clips` (scroll containers and
 * the viewport), or null when nothing of it shows.
 */
export function visiblePart(box: Box, clips: readonly Box[]): Box | null {
  let left = box.x;
  let top = box.y;
  let right = box.x + box.width;
  let bottom = box.y + box.height;
  for (const clip of clips) {
    left = Math.max(left, clip.x);
    top = Math.max(top, clip.y);
    right = Math.min(right, clip.x + clip.width);
    bottom = Math.min(bottom, clip.y + clip.height);
  }
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * An anchor counts as on screen when most of it shows. A column header half
 * scrolled away is not a place to point at.
 */
export function mostlyVisible(box: Box, clips: readonly Box[]): boolean {
  const part = visiblePart(box, clips);
  if (!part || box.width <= 0 || box.height <= 0) return false;
  return (part.width * part.height) / (box.width * box.height) >= 0.6;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The part of a clipping element that shows its content: the box inside its
 * borders and scrollbars (`client*`), less the edges where sticky chrome or a
 * fade covers what scrolls under them.
 */
export function clipArea(
  border: Box,
  client: { left: number; top: number; width: number; height: number },
  covered: Insets,
): Box {
  // An inline element has no client box; its border box is all there is.
  const inner =
    client.width > 0 || client.height > 0
      ? {
          x: border.x + client.left,
          y: border.y + client.top,
          width: client.width,
          height: client.height,
        }
      : border;
  return {
    x: inner.x + covered.left,
    y: inner.y + covered.top,
    width: Math.max(0, inner.width - covered.left - covered.right),
    height: Math.max(0, inner.height - covered.top - covered.bottom),
  };
}

export interface AnchorCandidate<T> {
  id: CoachAnchorId;
  item: T;
  box: Box;
}

function distance(a: Box, b: Box): number {
  return Math.hypot(
    a.x + a.width / 2 - (b.x + b.width / 2),
    a.y + a.height / 2 - (b.y + b.height / 2),
  );
}

/**
 * Picks where a coach mark points. Anchor ids go best first; the first id
 * with an element that shows wins. Among the elements of one id (a button on
 * every row), the one the mark followed last stays while it shows; when it
 * scrolls away or unmounts, the nearest one to where it was takes over, so
 * the mark moves a row and does not jump across the table. With nothing of
 * that id followed before, the first element in page order wins.
 */
export function pickAnchor<T>(
  anchors: readonly CoachAnchorId[],
  candidates: readonly AnchorCandidate<T>[],
  shows: (candidate: AnchorCandidate<T>) => boolean,
  recall: (id: CoachAnchorId) => { item: T; box: Box } | undefined,
): AnchorCandidate<T> | null {
  for (const id of anchors) {
    const own = candidates.filter((candidate) => candidate.id === id);
    const last = recall(id);
    if (!last) {
      const first = own.find(shows);
      if (first) return first;
      continue;
    }
    const same = own.find((candidate) => candidate.item === last.item);
    if (same && shows(same)) return same;
    const nearest = own
      .filter((candidate) => candidate !== same)
      .map((candidate, index) => ({
        candidate,
        index,
        away: distance(candidate.box, last.box),
      }))
      .sort((a, b) => a.away - b.away || a.index - b.index);
    for (const { candidate } of nearest) {
      if (shows(candidate)) return candidate;
    }
  }
  return null;
}
