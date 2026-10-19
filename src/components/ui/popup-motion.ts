"use client";

import * as React from "react";

import { useMotionAllowed } from "@/hooks/use-motion-allowed";

/** A little longer than the 100ms `popup-exit` in globals.css. */
const POPUP_EXIT_FALLBACK_MS = 150;

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/**
 * Motion for a Radix popup's content element (`.popup-motion` in
 * globals.css): the `data-motion` flag, and a ref that ends a stalled exit.
 *
 * Radix keeps a closed popup mounted until an `animationend` names the
 * animation it runs now. A paused animation clock (an occluded webview) never
 * sends it, and a popup whose motion turns off mid-exit (a key press makes
 * the user a keyboard user) has no animation left to end. A popup left
 * mounted comes back with its old state (a search typed into it) when it
 * opens again. So the ref sends that event itself: at once when no exit can
 * play, else after the exit's length.
 */
export function usePopupMotion<T extends HTMLElement>(ref?: React.Ref<T>) {
  const motionAllowed = useMotionAllowed();
  const setRef = React.useCallback(
    (node: T | null) => {
      assignRef(ref, node);
      if (!node) return;
      let timer = 0;
      const endExit = () => {
        if (!node.isConnected || node.dataset.state !== "closed") return;
        node.dispatchEvent(
          new AnimationEvent("animationend", {
            animationName: getComputedStyle(node).animationName,
          }),
        );
      };
      const observer = new MutationObserver(() => {
        window.clearTimeout(timer);
        if (node.dataset.state !== "closed") return;
        if (document.hidden || node.dataset.motion !== "on") endExit();
        else timer = window.setTimeout(endExit, POPUP_EXIT_FALLBACK_MS);
      });
      observer.observe(node, {
        attributes: true,
        attributeFilter: ["data-state", "data-motion"],
      });
      return () => {
        observer.disconnect();
        window.clearTimeout(timer);
        assignRef(ref, null);
      };
    },
    [ref],
  );
  return {
    "data-motion": motionAllowed ? "on" : undefined,
    ref: setRef,
  };
}
