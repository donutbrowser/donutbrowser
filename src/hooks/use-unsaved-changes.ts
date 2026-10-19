"use client";

import { useEffect, useRef } from "react";

/** One surface with edits that are not saved yet. */
export interface UnsavedChanges {
  dirty: boolean;
  /** Save the edits; resolve false when saving failed and the user stays. */
  save: () => Promise<boolean | undefined> | boolean | undefined;
  discard: () => void;
  /** What the surface is called in the prompt, already translated. */
  label?: string;
}

export type LeaveChoice = "save" | "discard" | "stay";

type LeavePrompt = (labels: string[]) => Promise<LeaveChoice>;

const registry = new Map<string, () => UnsavedChanges>();
let prompt: LeavePrompt | null = null;

/** Register a surface's unsaved edits while it is mounted. */
export function useUnsavedChanges(key: string, state: UnsavedChanges) {
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    registry.set(key, () => latest.current);
    return () => {
      registry.delete(key);
    };
  }, [key]);
}

/** The app shell installs the dialog that asks Save, Discard or Stay. */
export function setLeavePrompt(next: LeavePrompt | null) {
  prompt = next;
}

export function hasUnsavedChanges(): boolean {
  for (const read of registry.values()) {
    if (read().dirty) return true;
  }
  return false;
}

/**
 * Ask before a navigation that unmounts surfaces with unsaved edits.
 * Resolves true when the navigation may go on.
 */
export async function confirmLeave(): Promise<boolean> {
  const dirty = [...registry.values()]
    .map((read) => read())
    .filter((s) => s.dirty);
  if (dirty.length === 0) return true;
  if (!prompt) return true;
  const choice = await prompt(dirty.map((s) => s.label ?? "").filter(Boolean));
  if (choice === "stay") return false;
  if (choice === "discard") {
    for (const surface of dirty) surface.discard();
    return true;
  }
  for (const surface of dirty) {
    const saved = await surface.save();
    if (saved === false) return false;
  }
  return true;
}
