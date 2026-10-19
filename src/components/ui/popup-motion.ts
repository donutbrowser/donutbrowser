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
 * Radix keeps a closed popup mounted until its exit animation sends
 * `animationend`. A paused animation clock (an occluded webview) never sends
 * it, so a timer sends it instead, and the popup always leaves.
 */
export function usePopupMotion<T extends HTMLElement>(ref?: React.Ref<T>) {
  const motionAllowed = useMotionAllowed();
  const setRef = React.useCallback(
    (node: T | null) => {
      assignRef(ref, node);
      if (!node) return;
      let timer = 0;
      const observer = new MutationObserver(() => {
        window.clearTimeout(timer);
        if (node.dataset.state !== "closed") return;
        timer = window.setTimeout(() => {
          if (
            node.isConnected &&
            node.dataset.state === "closed" &&
            getComputedStyle(node).animationName === "popup-exit"
          ) {
            node.dispatchEvent(
              new AnimationEvent("animationend", {
                animationName: "popup-exit",
              }),
            );
          }
        }, POPUP_EXIT_FALLBACK_MS);
      });
      observer.observe(node, {
        attributes: true,
        attributeFilter: ["data-state"],
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
