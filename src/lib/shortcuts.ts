/**
 * Single source of truth for keyboard shortcuts. Each entry declares both how
 * to MATCH a real keyboard event (lowercase `key` + modifiers) and how to
 * DISPLAY it to the user. The display side branches on platform so macOS sees
 * the ⌘ glyph while everyone else sees `Ctrl`.
 */

import { isMacOS } from "@/lib/platform";

export type ShortcutGroup =
  | "navigation"
  | "actions"
  | "view"
  | "profiles"
  | "groups";

export interface ShortcutDef {
  /** Stable identifier — used by the global listener to dispatch to handlers. */
  id: ShortcutId;
  /** Translation key for the displayed label in the shortcuts page / palette. */
  labelKey: string;
  group: ShortcutGroup;
  /** Lowercased `KeyboardEvent.key`, e.g. "k", ",", "/". */
  key: string;
  /** Require the primary modifier (Cmd on mac, Ctrl elsewhere). */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /**
   * Match with or without Shift. For a symbol that some layouts type with
   * Shift: "/" is Shift+7 on a German keyboard.
   */
  anyShift?: boolean;
  /** False for a key that only means something where it is pressed. */
  palette?: boolean;
}

export type ShortcutId =
  | "newProfile"
  | "stopAllRunning"
  | "focusSearch"
  | "goBack"
  | "openPalette"
  | "openShortcuts"
  | "openTips"
  | "sendFeedback"
  | "openTotp"
  | "importProfile"
  | "goProfiles"
  | "goProxies"
  | "goExtensions"
  | "goGroups"
  | "goCookieBot"
  | "goAgent"
  | "goIntegrations"
  | "goAccount"
  | "goSettings"
  | "goTrash";

export const SHORTCUTS: ShortcutDef[] = [
  // Profiles
  {
    id: "newProfile",
    labelKey: "shortcuts.newProfile",
    group: "profiles",
    key: "n",
    mod: true,
  },
  {
    // Mod+Shift+S, "stop". Plain Mod+S stays free for save.
    id: "stopAllRunning",
    labelKey: "shortcuts.stopAllRunning",
    group: "profiles",
    key: "s",
    mod: true,
    shift: true,
  },
  {
    id: "focusSearch",
    labelKey: "shortcuts.focusSearch",
    group: "profiles",
    key: "/",
    anyShift: true,
  },
  // Actions
  {
    id: "openPalette",
    labelKey: "shortcuts.openPalette",
    group: "actions",
    key: "k",
    mod: true,
  },
  {
    id: "openShortcuts",
    labelKey: "shortcuts.openShortcuts",
    group: "actions",
    key: "/",
    mod: true,
  },
  {
    // Mod+Shift+H, "hints". Plain Mod+H hides the window on macOS.
    id: "openTips",
    labelKey: "shortcuts.openTips",
    group: "actions",
    key: "h",
    mod: true,
    shift: true,
  },
  {
    // Mod+Shift+F, "feedback". Plain Mod+F stays free for find.
    id: "sendFeedback",
    labelKey: "shortcuts.sendFeedback",
    group: "actions",
    key: "f",
    mod: true,
    shift: true,
  },
  {
    id: "openTotp",
    labelKey: "shortcuts.openTotp",
    group: "actions",
    key: "o",
    mod: true,
    shift: true,
  },
  {
    id: "importProfile",
    labelKey: "shortcuts.importProfile",
    group: "actions",
    key: "o",
    mod: true,
  },
  // Navigation
  {
    id: "goProfiles",
    labelKey: "shortcuts.goProfiles",
    group: "navigation",
    key: "p",
    mod: true,
  },
  {
    // Mod+Shift+N, "network". Plain Mod+N makes a new profile.
    id: "goProxies",
    labelKey: "shortcuts.goProxies",
    group: "navigation",
    key: "n",
    mod: true,
    shift: true,
  },
  {
    id: "goExtensions",
    labelKey: "shortcuts.goExtensions",
    group: "navigation",
    key: "e",
    mod: true,
  },
  {
    id: "goGroups",
    labelKey: "shortcuts.goGroups",
    group: "navigation",
    key: "g",
    mod: true,
  },
  {
    // Mod+B: "bot". Every other letter in the navigation group was taken.
    id: "goCookieBot",
    labelKey: "shortcuts.goCookieBot",
    group: "navigation",
    key: "b",
    mod: true,
  },
  {
    // Mod+J: the agent has no free mnemonic left — b is the cookie bot, a is
    // the account, g is groups — so an unclaimed key it is, rather than
    // stealing a chord the platform already means something by.
    id: "goAgent",
    labelKey: "shortcuts.goAgent",
    group: "navigation",
    key: "j",
    mod: true,
  },
  {
    id: "goIntegrations",
    labelKey: "shortcuts.goIntegrations",
    group: "navigation",
    key: "i",
    mod: true,
  },
  {
    // Mod+Shift+A (not Mod+A): plain Mod+A must stay select-all in any
    // focused text field or table context.
    id: "goAccount",
    labelKey: "shortcuts.goAccount",
    group: "navigation",
    key: "a",
    mod: true,
    shift: true,
  },
  {
    id: "goSettings",
    labelKey: "shortcuts.goSettings",
    group: "navigation",
    key: ",",
    mod: true,
  },
  {
    // Mod+Shift+T, the "reopen what I just closed" chord: the trash is where
    // a deleted profile comes back from. Plain Mod+T stays free.
    id: "goTrash",
    labelKey: "shortcuts.goTrash",
    group: "navigation",
    key: "t",
    mod: true,
    shift: true,
  },
  {
    // Leaves a page for Profiles when nothing on the page takes Escape.
    id: "goBack",
    labelKey: "shortcuts.goBack",
    group: "navigation",
    key: "Escape",
    palette: false,
  },
];

/**
 * Match Mod+1..9 to the group at that index (1-based). Returns the digit
 * pressed, or null. Used by the global keydown handler before falling back to
 * the static SHORTCUTS table.
 */
/**
 * Whether the event names a key. Chromium sends `keydown` without `key` when
 * autofill fills a field.
 */
export function isKey(e: Pick<KeyboardEvent, "key">): boolean {
  return typeof e.key === "string";
}

export function matchesGroupDigit(e: KeyboardEvent): number | null {
  if (!isKey(e) || !/^[1-9]$/.test(e.key)) return null;
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  const oppositeMod = isMac() ? e.ctrlKey : e.metaKey;
  if (!mod || oppositeMod || e.shiftKey || e.altKey) return null;
  return Number(e.key);
}

/** The keys of the Mod+digit shortcut for a group. Mirrors `shortcutKeys`. */
export function groupShortcutKeys(digit: number): KeyToken[] {
  return [keyToken("mod"), { glyph: String(digit), name: null }];
}

function isMac(): boolean {
  return isMacOS();
}

/** A key with its own name, drawn as a glyph on macOS. */
export type KeyName =
  | "mod"
  | "shift"
  | "alt"
  | "enter"
  | "escape"
  | "backspace"
  | "up"
  | "down";

/** One key of a chord: what the keycap shows, and its name when it has one. */
export interface KeyToken {
  glyph: string;
  name: KeyName | null;
}

const MAC_GLYPHS: Record<KeyName, string> = {
  mod: "⌘",
  shift: "⇧",
  alt: "⌥",
  enter: "↵",
  escape: "esc",
  backspace: "⌫",
  up: "↑",
  down: "↓",
};

const OTHER_GLYPHS: Record<KeyName, string> = {
  mod: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  enter: "Enter",
  escape: "Esc",
  backspace: "Backspace",
  up: "↑",
  down: "↓",
};

export function keyToken(name: KeyName): KeyToken {
  return { glyph: (isMac() ? MAC_GLYPHS : OTHER_GLYPHS)[name], name };
}

/**
 * The platform-correct keys of a shortcut, modifiers first. The shortcuts
 * page and the command palette both draw these, so the glyphs stay in sync.
 *
 * On macOS: ⌘ ⇧ ⌥ K
 * Elsewhere: Ctrl Shift Alt K
 */
export function shortcutKeys(s: ShortcutDef): KeyToken[] {
  const keys: KeyToken[] = [];
  if (s.mod) keys.push(keyToken("mod"));
  if (s.shift) keys.push(keyToken("shift"));
  if (s.alt) keys.push(keyToken("alt"));
  keys.push(
    s.key === "Escape"
      ? keyToken("escape")
      : { glyph: prettyKey(s.key), name: null },
  );
  return keys;
}

/** `shortcutKeys` as plain strings, for search. */
export function formatShortcut(s: ShortcutDef): string[] {
  return shortcutKeys(s).map((key) => key.glyph);
}

export interface HeldModifiers {
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

/** The modifiers a key event says are down, with Mod per platform. */
export function heldModifiers(e: KeyboardEvent): HeldModifiers {
  return {
    mod: isMac() ? e.metaKey : e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}

function prettyKey(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  // Named keys like "Enter", "Escape", etc. would already be capitalized.
  return key;
}

/**
 * Match a real `KeyboardEvent` against a shortcut definition. Returns true
 * only when modifiers are an exact match (so Ctrl+Shift+K doesn't fire
 * Ctrl+K).
 */
export function matchesShortcut(s: ShortcutDef, e: KeyboardEvent): boolean {
  if (!isKey(e) || e.key.toLowerCase() !== s.key.toLowerCase()) return false;
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  const oppositeMod = isMac() ? e.ctrlKey : e.metaKey;
  if (Boolean(s.mod) !== mod) return false;
  // Reject the wrong-platform modifier so Ctrl+K on macOS doesn't accidentally
  // trigger something that only expects ⌘+K.
  if (oppositeMod) return false;
  if (!s.anyShift && Boolean(s.shift) !== e.shiftKey) return false;
  if (Boolean(s.alt) !== e.altKey) return false;
  return true;
}
