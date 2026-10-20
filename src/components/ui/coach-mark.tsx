"use client";

import {
  animate,
  cancelFrame,
  frame,
  type MotionValue,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type AnchorCandidate,
  anchorSelector,
  type Box,
  COACH_MARK_EXIT_MS,
  type CoachAnchorId,
  clipArea,
  type Insets,
  mostlyVisible,
  pickAnchor,
  placeCoachMark,
  type Side,
  visiblePart,
} from "@/lib/coach-mark";
import { MOTION_DURATION, MOTION_EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** A modal surface is open; a coach mark waits behind it. */
const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"]';
/** The mark's own layers, and surfaces that pass over the page for a moment. */
const PASSING_LAYERS =
  "[data-coach-layer], [data-radix-popper-content-wrapper], [data-sonner-toaster]";
/** A new anchor closer than this to the ring is the same place: no travel. */
const SAME_PLACE_PX = 2;
/**
 * Observers report through the rendering loop, which a throttled webview
 * stops; this slow poll still places the card there. It runs only while the
 * window shows.
 */
const FALLBACK_POLL_MS = 2000;
/** DOM changes come in bursts; one measure after the burst is enough. */
const MUTATION_SETTLE_MS = 40;
/** A move to a new anchor travels; plain scrolling follows at once. */
const TRAVEL_MS = 560;
const TRAVEL_SPRING = {
  type: "spring" as const,
  stiffness: 340,
  damping: 34,
  mass: 0.9,
};
const ENTER_SPRING = {
  type: "spring" as const,
  stiffness: 480,
  damping: 30,
  mass: 0.7,
};
const ARROW_W = 18;
const ARROW_H = 9;

const SIDE_VALUES: readonly Side[] = ["top", "right", "bottom", "left"];
/** The arrow points up at rest; it turns to face the anchor. */
const ARROW_TURN: Record<Side, number> = {
  bottom: 0,
  top: 180,
  right: -90,
  left: 90,
};

interface CoachMarkIds {
  titleId: string;
  bodyId: string;
}

const CoachMarkContext = createContext<CoachMarkIds | null>(null);

function useCoachMarkIds(): CoachMarkIds {
  const ids = useContext(CoachMarkContext);
  if (!ids) throw new Error("Coach mark parts belong inside a CoachMark");
  return ids;
}

function toBox(rect: DOMRect): Box {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

function clipsContent(style: CSSStyleDeclaration): boolean {
  return style.overflowX !== "visible" || style.overflowY !== "visible";
}

/**
 * The edges of a `.scroll-fade` container that hide what scrolls under them:
 * the sticky header it declares, and each fade band while it shows.
 */
function coveredEdges(node: HTMLElement, style: CSSStyleDeclaration): Insets {
  if (!node.classList.contains("scroll-fade")) return NO_INSETS;
  const length = (name: string) =>
    Number.parseFloat(style.getPropertyValue(name)) || 0;
  const band = length("--scroll-fade-size");
  return {
    top:
      length("--scroll-fade-top-offset") +
      (node.dataset.fadeTop === "true" ? band : 0),
    right: 0,
    bottom: node.dataset.fadeBottom === "true" ? band : 0,
    left: 0,
  };
}

interface Ancestor {
  sticky: boolean;
  /**
   * When the element clips: what it shows of content that scrolls inside
   * it, and of sticky content, which its covered edges do not hide.
   */
  clip: { scrolling: Box; sticky: Box } | null;
}

/** Nothing of the page lies over the middle of what shows of the anchor. */
function uncovered(element: Element, part: Box): boolean {
  const top = document
    .elementsFromPoint(part.x + part.width / 2, part.y + part.height / 2)
    .find((hit) => !hit.closest(PASSING_LAYERS));
  return (
    !top || top === element || element.contains(top) || top.contains(element)
  );
}

/**
 * Reads what shows on screen, for one placement. The buttons of every row
 * share their scroll containers, so each element is read once.
 */
function createLens() {
  const viewport: Box = {
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  };
  const read = new Map<Element, Ancestor>();
  const ancestor = (node: HTMLElement): Ancestor => {
    const known = read.get(node);
    if (known) return known;
    const style = getComputedStyle(node);
    const sticky = style.position === "sticky";
    let found: Ancestor = { sticky, clip: null };
    if (clipsContent(style)) {
      const border = toBox(node.getBoundingClientRect());
      const client = {
        left: node.clientLeft,
        top: node.clientTop,
        width: node.clientWidth,
        height: node.clientHeight,
      };
      const whole = clipArea(border, client, NO_INSETS);
      const covered = coveredEdges(node, style);
      found = {
        sticky,
        clip: {
          scrolling:
            covered === NO_INSETS ? whole : clipArea(border, client, covered),
          sticky: whole,
        },
      };
    }
    read.set(node, found);
    return found;
  };

  /**
   * Every box that clips `element`: the window and its clipping ancestors. A
   * sticky header is not hidden by the edge it sticks to.
   */
  const clipsOf = (element: HTMLElement): Box[] => {
    const clips = [viewport];
    let pinned = ancestor(element).sticky;
    for (
      let node = element.parentElement;
      node && node !== document.body;
      node = node.parentElement
    ) {
      const { sticky, clip } = ancestor(node);
      if (clip) {
        clips.push(pinned ? clip.sticky : clip.scrolling);
        pinned = false;
      }
      if (sticky) pinned = true;
    }
    return clips;
  };

  /** Most of the element shows: not scrolled away, clipped or covered. */
  const shows = (element: HTMLElement, box: Box): boolean => {
    if (box.width < 1 || box.height < 1) return false;
    const clips = clipsOf(element);
    if (!mostlyVisible(box, clips)) return false;
    if (element.closest("[inert], [aria-hidden='true']")) return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") return false;
    const part = visiblePart(box, clips);
    return part !== null && uncovered(element, part);
  };

  /** The part of the page the element's scroll containers show. */
  const areaOf = (element: HTMLElement): Box => {
    const [first, ...rest] = clipsOf(element);
    return visiblePart(first, rest) ?? viewport;
  };

  return { viewport, shows, areaOf };
}

/** The element's clipping ancestors, to watch them change size. */
function clippingAncestors(element: Element): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (
    let node = element.parentElement;
    node && node !== document.body;
    node = node.parentElement
  ) {
    if (clipsContent(getComputedStyle(node))) found.push(node);
  }
  return found;
}

/**
 * Calls `onMove` when `element` moves or grows on screen, a transform
 * included, with no polling. An IntersectionObserver whose root margin hugs
 * the element's box sees any shift as a drop of the visible ratio; it is then
 * rebuilt around the new box. Returns the disconnect.
 */
function watchMoves(element: Element, onMove: () => void): () => void {
  let observer: IntersectionObserver | null = null;
  const stop = () => {
    observer?.disconnect();
    observer = null;
  };
  const start = (threshold: number) => {
    stop();
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const root = document.documentElement;
    const margin = [
      rect.top,
      root.clientWidth - rect.right,
      root.clientHeight - rect.bottom,
      rect.left,
    ]
      .map((inset) => `${-Math.floor(inset)}px`)
      .join(" ");
    const level = Math.min(1, Math.max(threshold, 0.01));
    let first = true;
    observer = new IntersectionObserver(
      ([entry]) => {
        if (!first) {
          // Only a crossing of the level reports again: the box changed.
          onMove();
          start(1);
          return;
        }
        first = false;
        // The first report is where the element starts. Part of it may be
        // clipped already: watch for a drop below what shows now.
        const ratio = entry?.intersectionRatio ?? 0;
        if (ratio > 0.01 && Math.abs(ratio - level) > 0.001) start(ratio);
      },
      { rootMargin: margin, threshold: level },
    );
    observer.observe(element);
  };
  start(1);
  return stop;
}

/**
 * Where to point now: the first anchor id, by preference, with an element
 * that shows. The element followed last keeps the mark while it shows; when
 * it scrolls away or unmounts, the nearest one of the same id takes over.
 */
function resolveAnchor(
  anchors: readonly CoachAnchorId[],
  lens: ReturnType<typeof createLens>,
  memory: Map<CoachAnchorId, { item: HTMLElement; box: Box }>,
): AnchorCandidate<HTMLElement> | null {
  const candidates: AnchorCandidate<HTMLElement>[] = [];
  for (const id of anchors) {
    for (const item of document.querySelectorAll<HTMLElement>(
      anchorSelector(id),
    )) {
      candidates.push({ id, item, box: toBox(item.getBoundingClientRect()) });
    }
  }
  const found = pickAnchor(
    anchors,
    candidates,
    (candidate) => lens.shows(candidate.item, candidate.box),
    (id) => memory.get(id),
  );
  if (found) memory.set(found.id, { item: found.item, box: found.box });
  return found;
}

/**
 * Adds or removes one id in an element's `aria-describedby`, leaving the
 * others alone: a tooltip on the same element manages its own id there.
 */
function describe(element: Element, id: string, on: boolean) {
  const ids = (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const has = ids.includes(id);
  if (on === has) return;
  const next = on ? [...ids, id] : ids.filter((other) => other !== id);
  if (next.length > 0) element.setAttribute("aria-describedby", next.join(" "));
  else element.removeAttribute("aria-describedby");
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

/**
 * Where the arrow sits and which way it points, for the side the card took.
 * The arrow is an 18x9 triangle that turns about its middle; its base sinks
 * one pixel into the card so the card's hairline does not cross it.
 */
function arrowTransform(
  side: Side,
  arrow: number,
  card: { width: number; height: number },
) {
  switch (side) {
    case "bottom":
      return { x: arrow - ARROW_W / 2, y: -ARROW_H + 1 };
    case "top":
      return { x: arrow - ARROW_W / 2, y: card.height - 1 };
    case "right":
      return { x: -ARROW_W / 2 - ARROW_H / 2 + 1, y: arrow - ARROW_H / 2 };
    case "left":
      return {
        x: card.width - ARROW_W / 2 + ARROW_H / 2 - 1,
        y: arrow - ARROW_H / 2,
      };
  }
}

function originFor(side: Side, arrow: number): string {
  switch (side) {
    case "bottom":
      return `${arrow}px 0px`;
    case "top":
      return `${arrow}px 100%`;
    case "right":
      return `0px ${arrow}px`;
    case "left":
      return `100% ${arrow}px`;
  }
}

/** The card starts a few pixels toward its anchor and settles away from it. */
function entranceOffset(side: Side | null): { x: number; y: number } {
  switch (side) {
    case "bottom":
      return { x: 0, y: -6 };
    case "top":
      return { x: 0, y: 6 };
    case "right":
      return { x: -6, y: 0 };
    case "left":
      return { x: 6, y: 0 };
    default:
      return { x: 0, y: 8 };
  }
}

/** A rounded rectangle cut out of a sheet that covers any window. */
function spotlightPath(x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  return `M-1 -1H100000V100000H-1Z M${x + radius} ${y}H${x + w - radius}A${radius} ${radius} 0 0 1 ${x + w} ${y + radius}V${y + h - radius}A${radius} ${radius} 0 0 1 ${x + w - radius} ${y + h}H${x + radius}A${radius} ${radius} 0 0 1 ${x} ${y + h - radius}V${y + radius}A${radius} ${radius} 0 0 1 ${x + radius} ${y}Z`;
}

interface Layout {
  anchor: CoachAnchorId | null;
  side: Side | null;
  hidden: boolean;
}

type DataAttributes = {
  [key: `data-${string}`]: string | number | boolean | undefined;
};

export interface CoachMarkProps extends DataAttributes {
  /** False plays the exit. The owner unmounts the mark `COACH_MARK_EXIT_MS` later. */
  open: boolean;
  /** Where to point, best first. The first anchor that shows wins. */
  anchors: readonly CoachAnchorId[];
  /** With no anchor on screen, wait at the bottom of the window instead of hiding. */
  floatWithoutAnchor?: boolean;
  /** Dims the page around the anchor, for a guided tour. */
  spotlight?: boolean;
  /** The side to prefer when the anchor does not name one (`data-tip-side`). */
  side?: Side;
  /** Escape. The owner's own close controls call their handlers directly. */
  onDismiss: () => void;
  /** The person used the feature the mark points at. */
  onAnchorActivate?: () => void;
  /** Read out politely when the mark appears. */
  announcement?: string;
  /** Changes with the content (a tour step), so the card travels to the new anchor. */
  stepKey?: string | number;
  /** Already introduced this session: appear at rest, without the entrance or the beacon's pulse. */
  settled?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Points at a real element: a ring drawn around it, a beacon on its corner,
 * and a card beside it with an arrow. The anchor is found by its
 * `data-tip-anchor` id, and the mark follows it through scrolling, resizing
 * and re-renders, flipping sides to stay on screen. An anchor counts only
 * while most of it shows: scrolled out of a container, under a sticky header
 * or a fade band, covered, or unmounted, it gives the mark to the next anchor
 * that shows, and with none the mark waits hidden until one comes back.
 *
 * It never takes the focus. The card is a labelled region whose buttons are in
 * the tab order, the anchor is described by the card's text while the mark
 * points at it, and Escape closes it. It hides while a modal surface is open.
 *
 * Motion is decoration: the card is fully opaque from its first frame and
 * only travels and scales into place, so a stalled frame clock leaves it
 * readable. Reduced motion shows every part at rest.
 */
export function CoachMark({
  open,
  anchors,
  floatWithoutAnchor = false,
  spotlight = false,
  side: preferredSide = "bottom",
  onDismiss,
  onAnchorActivate,
  announcement,
  stepKey,
  settled = false,
  className,
  children,
  ...dataAttributes
}: CoachMarkProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const quiet = reduceMotion || settled;
  const titleId = useId();
  const bodyId = useId();
  const [mounted, setMounted] = useState(false);
  const [layout, setLayout] = useState<Layout>({
    anchor: null,
    side: null,
    hidden: true,
  });
  const [spoken, setSpoken] = useState("");

  const cardRef = useRef<HTMLElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  /** Runs after each measure: follows the anchor that measure chose. */
  const afterMeasureRef = useRef<(() => void) | null>(null);
  const travelUntilRef = useRef(0);
  const shownRef = useRef(false);
  /** The last measure hid the mark: its next appearance does not travel. */
  const hiddenRef = useRef(true);
  /** The element each anchor id pointed at last, and where it was. */
  const memoryRef = useRef(
    new Map<CoachAnchorId, { item: HTMLElement; box: Box }>(),
  );

  const cardX = useMotionValue(0);
  const cardY = useMotionValue(0);
  const enterX = useMotionValue(0);
  const enterY = useMotionValue(0);
  const enterScale = useMotionValue(1);
  const cardOpacity = useMotionValue(1);
  const ringX = useMotionValue(0);
  const ringY = useMotionValue(0);
  const ringW = useMotionValue(0);
  const ringH = useMotionValue(0);
  const ringR = useMotionValue(8);
  const arrowX = useMotionValue(0);
  const arrowY = useMotionValue(0);
  const beaconX = useMotionValue(0);
  const beaconY = useMotionValue(0);
  const hole = useTransform(
    [ringX, ringY, ringW, ringH, ringR],
    ([x, y, w, h, r]: number[]) => spotlightPath(x, y, w, h, r),
  );

  const latest = useRef({
    anchors,
    preferredSide,
    spotlight,
    reduceMotion,
    quiet,
    floatWithoutAnchor,
    open,
  });
  latest.current = {
    anchors,
    preferredSide,
    spotlight,
    reduceMotion,
    quiet,
    floatWithoutAnchor,
    open,
  };

  const measure = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    const {
      anchors,
      preferredSide,
      spotlight,
      reduceMotion,
      quiet,
      floatWithoutAnchor,
      open,
    } = latest.current;
    const blocked = Boolean(document.querySelector(MODAL_SELECTOR));
    const lens = createLens();
    const found = blocked
      ? null
      : resolveAnchor(anchors, lens, memoryRef.current);
    const element = found?.item ?? null;
    const hidden = blocked || (!found && !floatWithoutAnchor);
    const { viewport } = lens;
    const size = { width: card.offsetWidth, height: card.offsetHeight };

    const pad = spotlight ? 6 : 4;
    const ring = found
      ? {
          x: found.box.x - pad,
          y: found.box.y - pad,
          width: found.box.width + pad * 2,
          height: found.box.height + pad * 2,
        }
      : null;
    const now = performance.now();
    if (
      ring &&
      shownRef.current &&
      !hiddenRef.current &&
      !hidden &&
      !reduceMotion &&
      element !== anchorRef.current &&
      (Math.abs(ringX.get() - ring.x) > SAME_PLACE_PX ||
        Math.abs(ringY.get() - ring.y) > SAME_PLACE_PX)
    ) {
      travelUntilRef.current = now + TRAVEL_MS;
    }
    if (hiddenRef.current) travelUntilRef.current = 0;
    const travel = now < travelUntilRef.current;
    const move = (value: MotionValue<number>, target: number) => {
      if (travel) animate(value, target, TRAVEL_SPRING);
      else value.jump(target);
    };
    // The anchor is described by the card while the mark points at it.
    const previous = anchorRef.current;
    if (previous && previous !== element) describe(previous, bodyId, false);
    if (element) describe(element, bodyId, open && !hidden);
    anchorRef.current = element;

    let side: Side | null = null;
    if (element && ring) {
      const radius =
        Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 6;
      const named = element.getAttribute("data-tip-side");
      const options = {
        side: SIDE_VALUES.includes(named as Side)
          ? (named as Side)
          : preferredSide,
        gap: ARROW_H + 4,
      };
      // Inside the part of its scroll container that shows, when the card
      // fits there; else anywhere in the window.
      const inside = placeCoachMark(ring, size, lens.areaOf(element), options);
      const placed = inside.fits
        ? inside
        : placeCoachMark(ring, size, viewport, options);
      side = placed.side;
      const arrow = arrowTransform(placed.side, placed.arrow, size);
      move(cardX, placed.x);
      move(cardY, placed.y);
      move(ringX, ring.x);
      move(ringY, ring.y);
      move(ringW, ring.width);
      move(ringH, ring.height);
      move(ringR, Math.min(radius + pad, 14));
      move(beaconX, ring.x + ring.width - 3);
      move(beaconY, ring.y + 3);
      move(arrowX, arrow.x);
      move(arrowY, arrow.y);
      card.style.transformOrigin = originFor(placed.side, placed.arrow);
    } else {
      move(cardX, (viewport.width - size.width) / 2);
      move(cardY, viewport.height - size.height - 24);
      card.style.transformOrigin = "50% 100%";
      // The spotlight closes its hole: there is nothing to show through it.
      move(ringX, ringX.get() + ringW.get() / 2);
      move(ringY, ringY.get() + ringH.get() / 2);
      move(ringW, 0);
      move(ringH, 0);
    }

    // The first time the card shows, it settles out from its anchor.
    if (!hidden && !shownRef.current && !quiet) {
      const offset = entranceOffset(side);
      enterX.jump(offset.x);
      enterY.jump(offset.y);
      enterScale.jump(0.94);
      animate(enterX, 0, ENTER_SPRING);
      animate(enterY, 0, ENTER_SPRING);
      animate(enterScale, 1, ENTER_SPRING);
    }
    if (!hidden) shownRef.current = true;
    hiddenRef.current = hidden;

    setLayout((previous) =>
      previous.anchor === (found?.id ?? null) &&
      previous.side === side &&
      previous.hidden === hidden
        ? previous
        : { anchor: found?.id ?? null, side, hidden },
    );
    afterMeasureRef.current?.();
  }, [
    bodyId,
    cardX,
    cardY,
    enterX,
    enterY,
    enterScale,
    ringX,
    ringY,
    ringW,
    ringH,
    ringR,
    beaconX,
    beaconY,
    arrowX,
    arrowY,
  ]);

  useEffect(() => setMounted(true), []);

  // Placed before the first paint, then kept in place by every event that can
  // move the anchor: scrolling anywhere (the window or any scroll container),
  // resizing, DOM changes, the anchor or its scroll containers moving or
  // changing size, a candidate anchor coming into or out of view. Events only
  // ask for a measure; the frame loop runs one per frame, before the frame's
  // render, so the mark moves in the same frame as the page. Only a slow
  // fallback poll runs on a timer.
  useLayoutEffect(() => {
    if (!mounted) return;
    const onFrame = () => measure();
    const schedule = () => frame.read(onFrame);
    let settle = 0;
    const onMutation = () => {
      window.clearTimeout(settle);
      settle = window.setTimeout(schedule, MUTATION_SETTLE_MS);
    };
    const measureIfVisible = () => {
      if (document.visibilityState === "visible") measure();
    };
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, {
      capture: true,
      passive: true,
    });
    document.addEventListener("visibilitychange", measureIfVisible);
    const resize = new ResizeObserver(schedule);
    if (cardRef.current) resize.observe(cardRef.current);
    const mutations = new MutationObserver(onMutation);
    mutations.observe(document.body, { childList: true, subtree: true });

    // Candidates crossing the "mostly visible" line (0.6) change the anchor.
    const candidates = new IntersectionObserver(schedule, {
      threshold: [0.5, 0.6, 0.7, 1],
    });
    let watchedCandidates: Element[] = [];
    let followed: HTMLElement | null = null;
    let containers: HTMLElement[] = [];
    let stopMoves: (() => void) | null = null;
    afterMeasureRef.current = () => {
      const anchor = anchorRef.current;
      if (anchor !== followed) {
        if (followed) resize.unobserve(followed);
        for (const container of containers) resize.unobserve(container);
        stopMoves?.();
        stopMoves = null;
        followed = anchor;
        containers = anchor ? clippingAncestors(anchor) : [];
        if (anchor) {
          resize.observe(anchor);
          for (const container of containers) resize.observe(container);
          stopMoves = watchMoves(anchor, schedule);
        }
      }
      const selector = latest.current.anchors.map(anchorSelector).join(",");
      const next = selector
        ? Array.from(document.querySelectorAll(selector))
        : [];
      if (
        next.length !== watchedCandidates.length ||
        next.some((element, index) => element !== watchedCandidates[index])
      ) {
        candidates.disconnect();
        for (const element of next) candidates.observe(element);
        watchedCandidates = next;
      }
    };
    measure();
    const poll = window.setInterval(measureIfVisible, FALLBACK_POLL_MS);
    return () => {
      window.clearInterval(poll);
      cancelFrame(onFrame);
      afterMeasureRef.current = null;
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, { capture: true });
      document.removeEventListener("visibilitychange", measureIfVisible);
      resize.disconnect();
      mutations.disconnect();
      candidates.disconnect();
      stopMoves?.();
      window.clearTimeout(settle);
    };
  }, [mounted, measure]);

  // A new step or a new list of anchors is placed at once.
  const anchorKey = anchors.join(" ");
  useLayoutEffect(() => {
    if (mounted && (stepKey !== undefined || anchorKey)) measure();
  }, [mounted, measure, stepKey, anchorKey]);

  // The exit: a short fade and a slight shrink toward the anchor.
  useEffect(() => {
    if (open) {
      cardOpacity.jump(1);
      return;
    }
    const exit = {
      duration: (COACH_MARK_EXIT_MS - 30) / 1000,
      ease: MOTION_EASE_OUT,
    };
    animate(cardOpacity, 0, exit);
    if (!reduceMotion) animate(enterScale, 0.97, exit);
  }, [open, reduceMotion, cardOpacity, enterScale]);

  // Closing or leaving takes the description off the anchor.
  useEffect(() => {
    if (open) return;
    if (anchorRef.current) describe(anchorRef.current, bodyId, false);
  }, [open, bodyId]);
  useEffect(
    () => () => {
      if (anchorRef.current) describe(anchorRef.current, bodyId, false);
    },
    [bodyId],
  );

  // Escape closes the mark when nothing in front of it wants the key: a field,
  // a menu or a dialog keeps Escape for itself. Using the feature the mark
  // points at tells its owner.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const activateRef = useRef(onAnchorActivate);
  activateRef.current = onAnchorActivate;
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const inside = cardRef.current?.contains(event.target as Node) ?? false;
      if (!inside) {
        if (isEditable(event.target)) return;
        if (document.querySelector(`${MODAL_SELECTOR}, [role="menu"]`)) return;
      }
      event.preventDefault();
      dismissRef.current();
    };
    const onClick = (event: MouseEvent) => {
      const anchor = anchorRef.current;
      if (!anchor || !activateRef.current) return;
      if (event.target instanceof Node && anchor.contains(event.target)) {
        activateRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [open]);

  // Spoken a moment after it appears, so the live region already exists.
  useEffect(() => {
    if (!open || layout.hidden || !announcement) return;
    const timer = window.setTimeout(() => setSpoken(announcement), 120);
    return () => window.clearTimeout(timer);
  }, [open, layout.hidden, announcement]);

  if (!mounted) return null;

  const hidden = layout.hidden;
  const anchored = layout.anchor !== null && !hidden;
  const visibility = hidden ? "hidden" : "visible";
  const leaving = !open;

  return createPortal(
    <CoachMarkContext.Provider value={{ titleId, bodyId }}>
      {spotlight && (
        <svg
          aria-hidden="true"
          data-coach-layer=""
          data-slot="coach-mark-spotlight"
          className="pointer-events-none fixed inset-0 z-[70] h-full w-full"
          style={{ visibility }}
        >
          <motion.path
            d={hole}
            fillRule="evenodd"
            className="pointer-events-auto"
            style={{
              fill: "color-mix(in oklab, var(--background) 70%, transparent)",
            }}
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: leaving ? 0 : 1 }}
            transition={{
              duration: leaving ? 0.16 : MOTION_DURATION.slow,
              ease: MOTION_EASE_OUT,
            }}
          />
        </svg>
      )}

      {anchored && (
        <svg
          aria-hidden="true"
          data-coach-layer=""
          data-slot="coach-mark-ring"
          className="pointer-events-none fixed inset-0 z-[71] h-full w-full overflow-visible"
        >
          <motion.rect
            key={layout.anchor}
            x={ringX}
            y={ringY}
            width={ringW}
            height={ringH}
            rx={ringR}
            fill="none"
            strokeWidth={1.5}
            style={{
              stroke: "color-mix(in oklab, var(--primary) 60%, transparent)",
            }}
            initial={quiet ? false : { pathLength: 0 }}
            animate={{ pathLength: 1, opacity: leaving ? 0 : 1 }}
            transition={{
              pathLength: { duration: 0.7, ease: MOTION_EASE_OUT, delay: 0.1 },
              opacity: { duration: 0.14 },
            }}
          />
        </svg>
      )}

      {anchored && (
        <motion.div
          aria-hidden="true"
          data-coach-layer=""
          data-slot="coach-mark-beacon"
          className="pointer-events-none fixed top-0 left-0 z-[72] -mt-1.5 -ml-1.5 size-3"
          style={{ x: beaconX, y: beaconY }}
        >
          {!quiet && !leaving && (
            <motion.span
              key={layout.anchor}
              className="absolute inset-0 rounded-full bg-primary"
              initial={{ scale: 1, opacity: 0 }}
              animate={{ scale: [1, 2.8], opacity: [0.5, 0] }}
              transition={{
                duration: 1.6,
                ease: "easeOut",
                repeat: 4,
                repeatDelay: 1,
                delay: 0.4,
              }}
            />
          )}
          <motion.span
            className="absolute inset-0 rounded-full bg-primary ring-2 ring-background"
            initial={quiet ? false : { scale: 0.4 }}
            animate={{ scale: leaving ? 0.6 : 1, opacity: leaving ? 0 : 1 }}
            transition={leaving ? { duration: 0.14 } : ENTER_SPRING}
          />
        </motion.div>
      )}

      <motion.div
        data-coach-layer=""
        className="pointer-events-none fixed top-0 left-0 z-[73]"
        style={{ x: cardX, y: cardY, visibility }}
      >
        <motion.section
          ref={cardRef}
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          data-slot="coach-mark"
          {...dataAttributes}
          data-state={leaving ? "leaving" : "shown"}
          data-anchor={layout.anchor ?? "none"}
          data-side={layout.side ?? undefined}
          className={cn(
            // flow-root keeps a child's top margin inside the card, so the
            // box that is measured is the box that is drawn.
            "pointer-events-auto relative flow-root w-80 max-w-[calc(100vw-1rem)] rounded-xl bg-popover text-popover-foreground shadow-xl ring-1 ring-foreground/12",
            className,
          )}
          style={{
            x: enterX,
            y: enterY,
            scale: enterScale,
            opacity: cardOpacity,
          }}
        >
          {anchored && (
            <motion.div
              aria-hidden="true"
              className="pointer-events-none absolute top-0 left-0"
              style={{
                x: arrowX,
                y: arrowY,
                rotate: ARROW_TURN[layout.side ?? "bottom"],
                width: ARROW_W,
                height: ARROW_H,
              }}
            >
              <svg
                aria-hidden="true"
                viewBox={`0 0 ${ARROW_W} ${ARROW_H}`}
                width={ARROW_W}
                height={ARROW_H}
                className="block overflow-visible"
              >
                <path
                  d={`M0 ${ARROW_H} L${ARROW_W / 2} 0.5 L${ARROW_W} ${ARROW_H}`}
                  strokeWidth={1}
                  strokeLinejoin="round"
                  style={{
                    fill: "var(--popover)",
                    stroke:
                      "color-mix(in oklab, var(--foreground) 12%, transparent)",
                  }}
                />
              </svg>
            </motion.div>
          )}
          {children}
        </motion.section>
      </motion.div>

      <div role="status" aria-live="polite" className="sr-only">
        {open && !hidden ? spoken : ""}
      </div>
    </CoachMarkContext.Provider>,
    document.body,
  );
}

/** The drawing at the top of a card. Decorative. */
export function CoachMarkScene({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      aria-hidden="true"
      data-slot="coach-mark-scene"
      className={cn(
        "relative mx-2 mt-2 h-28 overflow-hidden rounded-lg bg-foreground/[0.03] ring-1 ring-foreground/6 ring-inset [@media(max-height:640px)]:h-24 [@media(max-height:460px)]:hidden",
        "[background-image:radial-gradient(color-mix(in_oklab,var(--foreground)_10%,transparent)_1px,transparent_1.2px)] [background-size:14px_14px] [background-position:7px_7px]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CoachMarkHeader({
  eyebrow,
  title,
  aside,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  aside?: ReactNode;
}) {
  const { titleId } = useCoachMarkIds();
  return (
    <div className="flex items-start gap-2 px-4 pt-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {eyebrow && (
          <p className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            {eyebrow}
          </p>
        )}
        <h2
          id={titleId}
          className="text-sm leading-snug font-semibold tracking-tight text-balance"
        >
          {title}
        </h2>
      </div>
      {aside}
    </div>
  );
}

export function CoachMarkBody({ children }: { children: ReactNode }) {
  const { bodyId } = useCoachMarkIds();
  return (
    <p
      id={bodyId}
      className="px-4 pt-1.5 text-xs leading-relaxed text-pretty text-muted-foreground"
    >
      {children}
    </p>
  );
}

export function CoachMarkFooter({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("flex items-center justify-between gap-2 p-3", className)}
    >
      {children}
    </div>
  );
}
