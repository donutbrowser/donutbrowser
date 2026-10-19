"use client";

import { animate, usePresence } from "motion/react";
import * as React from "react";
import { MOTION_EASE_OUT } from "@/lib/motion";

/** A little longer than the 100ms fade; ends the exit when the clock stalls. */
const EXIT_FALLBACK_MS = 150;

/**
 * Keeps a leaving table row in the DOM only while it fades, under an
 * `AnimatePresence mode="popLayout"`.
 *
 * A row that left the data fades out over 100ms; a row that only scrolled
 * out of the rendered window goes at once. The ghost loses its row
 * attributes, so table queries never find it, and a timer removes it even
 * when a stalled animation clock never finishes the fade.
 */
export function RowPresence({
  ref,
  fades,
  children,
}: {
  ref?: React.Ref<HTMLTableRowElement>;
  /** Asked when the row leaves: should it fade? */
  fades: () => boolean;
  children: (ref: React.RefCallback<HTMLTableRowElement>) => React.ReactNode;
}) {
  const [isPresent, safeToRemove] = usePresence();
  const element = React.useRef<HTMLTableRowElement | null>(null);
  const fadesRef = React.useRef(fades);
  fadesRef.current = fades;

  const setRef = React.useCallback(
    (node: HTMLTableRowElement | null) => {
      element.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  React.useEffect(() => {
    if (isPresent) return;
    const node = element.current;
    if (!node || !fadesRef.current()) {
      safeToRemove();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      safeToRemove();
    };
    const rowId = node.getAttribute("data-table-row");
    const profileId = node.getAttribute("data-profile-id");
    node.removeAttribute("data-table-row");
    node.removeAttribute("data-profile-id");
    node.setAttribute("aria-hidden", "true");
    node.inert = true;
    const controls = animate(
      node,
      { opacity: 0 },
      { duration: 0.1, ease: MOTION_EASE_OUT },
    );
    void controls.then(finish);
    const timer = window.setTimeout(finish, EXIT_FALLBACK_MS);
    return () => {
      window.clearTimeout(timer);
      controls.stop();
      if (done) return;
      // The row came back before it left: undo the ghost.
      if (rowId) node.setAttribute("data-table-row", rowId);
      if (profileId) node.setAttribute("data-profile-id", profileId);
      node.removeAttribute("aria-hidden");
      node.inert = false;
      node.style.opacity = "";
    };
  }, [isPresent, safeToRemove]);

  return children(setRef);
}
