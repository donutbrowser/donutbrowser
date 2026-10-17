"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { KbdGroup } from "@/components/ui/kbd";
import { MatchText } from "@/components/ui/match-text";
import { useInputModality } from "@/hooks/use-input-modality";
import { MOTION_EASE_OUT } from "@/lib/motion";
import { paletteScore } from "@/lib/palette-search";
import {
  groupShortcutKeys,
  type HeldModifiers,
  heldModifiers,
  type KeyToken,
  keyToken,
  matchesGroupDigit,
  matchesShortcut,
  SHORTCUTS,
  shortcutKeys,
} from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

interface GroupTarget {
  id: string;
  name: string;
}

interface ShortcutsPageProps {
  /** Ordered list — first 9 entries display their Mod+digit binding. */
  groupTargets: GroupTarget[];
  onOpenPalette: () => void;
}

interface Row {
  id: string;
  label: string;
  keywords: string[];
  keys: KeyToken[];
  mods: HeldModifiers;
}

const NONE: HeldModifiers = { mod: false, shift: false, alt: false };

const PALETTE_SHORTCUT =
  SHORTCUTS.find((s) => s.id === "openPalette") ?? SHORTCUTS[0];

function sameModifiers(a: HeldModifiers, b: HeldModifiers) {
  return a.mod === b.mod && a.shift === b.shift && a.alt === b.alt;
}

/** A row stays lit while the held modifiers are all part of its chord. */
function acceptsHeld(row: Row, held: HeldModifiers) {
  return (
    (!held.mod || row.mods.mod) &&
    (!held.shift || row.mods.shift) &&
    (!held.alt || row.mods.alt)
  );
}

function modifierHeld(token: KeyToken, held: HeldModifiers) {
  return (
    (token.name === "mod" && held.mod) ||
    (token.name === "shift" && held.shift) ||
    (token.name === "alt" && held.alt)
  );
}

export function ShortcutsPage({
  groupTargets,
  onOpenPalette,
}: ShortcutsPageProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const inputModality = useInputModality();
  const [search, setSearch] = useState("");
  const [held, setHeld] = useState<HeldModifiers>(NONE);
  // The row whose chord was just pressed, and when, so each press replays.
  const [hit, setHit] = useState<{ id: string; at: number } | null>(null);
  const [tapped, setTapped] = useState<string | null>(null);
  // How many keys of the palette chord the demo holds down.
  const [demo, setDemo] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const groupCount = useRef(0);
  useEffect(() => {
    groupCount.current = Math.min(groupTargets.length, 9);
  }, [groupTargets.length]);
  const paletteKeys = shortcutKeys(PALETTE_SHORTCUT);
  const holdKeys = [keyToken("mod"), keyToken("shift"), keyToken("alt")];

  // The sections come in one after another when the page is opened by
  // pointer; by keyboard, and on every later filter, they are just there.
  const [entrance] = useState(
    () => !reduceMotion && inputModality === "pointer",
  );
  const entered = useRef(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      entered.current = true;
    }, 400);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let release = 0;
    const sync = (event: KeyboardEvent) => {
      const next = heldModifiers(event);
      setHeld((prev) => (sameModifiers(prev, next) ? prev : next));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      sync(event);
      if (event.repeat) return;
      const shortcut = SHORTCUTS.find((s) => matchesShortcut(s, event));
      const digit = matchesGroupDigit(event);
      const id =
        shortcut?.id ??
        (digit !== null && digit <= groupCount.current
          ? `group-${digit}`
          : null);
      if (!id) return;
      setHit({ id, at: performance.now() });
      setTapped(id);
      window.clearTimeout(release);
      release = window.setTimeout(() => {
        setTapped(null);
      }, 160);
    };
    const reset = () => {
      setHeld(NONE);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", reset);
    return () => {
      window.clearTimeout(release);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", reset);
    };
  }, []);

  useEffect(() => {
    if (!hit) return;
    listRef.current
      ?.querySelector(`[data-shortcut-row="${hit.id}"]`)
      ?.scrollIntoView({
        block: "nearest",
        behavior: reduceMotion ? "auto" : "smooth",
      });
  }, [hit, reduceMotion]);

  // The palette chord presses itself once, as a hint, and again on hover.
  const playDemo = () => {
    if (reduceMotion || demo !== 0) return;
    setDemo(1);
  };
  useEffect(() => {
    if (reduceMotion) return;
    const timer = window.setTimeout(() => {
      setDemo(1);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [reduceMotion]);
  const chordLength = paletteKeys.length;
  useEffect(() => {
    if (demo === 0) return;
    const timer = window.setTimeout(
      () => {
        setDemo((step) => (step >= chordLength ? 0 : step + 1));
      },
      demo >= chordLength ? 320 : 140,
    );
    return () => window.clearTimeout(timer);
  }, [demo, chordLength]);

  const shortcutRow = (s: (typeof SHORTCUTS)[number]): Row => ({
    id: s.id,
    label: t(s.labelKey),
    keywords: [t(`commandPalette.keywords.${s.id}`)],
    keys: shortcutKeys(s),
    mods: { mod: !!s.mod, shift: !!s.shift, alt: !!s.alt },
  });
  const paletteRow = (id: string, keys: KeyToken[]): Row => ({
    id: `palette-${id}`,
    label: t(`shortcutsPage.paletteKeys.${id}`),
    keywords: [],
    keys,
    mods: NONE,
  });

  const sections: Array<{ id: string; title: string; rows: Row[] }> = [
    {
      id: "navigation",
      title: t("commandPalette.groups.navigation"),
      rows: SHORTCUTS.filter((s) => s.group === "navigation").map(shortcutRow),
    },
    {
      id: "actions",
      title: t("commandPalette.groups.actions"),
      rows: SHORTCUTS.filter((s) => s.group === "actions").map(shortcutRow),
    },
    {
      id: "groups",
      title: t("commandPalette.groups.profileGroups"),
      rows: groupTargets.slice(0, 9).map((target, index) => ({
        id: `group-${index + 1}`,
        label: target.name,
        keywords: [],
        keys: groupShortcutKeys(index + 1),
        mods: { mod: true, shift: false, alt: false },
      })),
    },
    {
      id: "palette",
      title: t("shortcutsPage.paletteKeys.title"),
      rows: [
        paletteRow("move", [keyToken("up"), keyToken("down")]),
        paletteRow("run", [keyToken("enter")]),
        paletteRow("back", [keyToken("backspace")]),
        paletteRow("close", [keyToken("escape")]),
      ],
    },
  ]
    .map((section) => ({
      ...section,
      rows: section.rows.filter(
        (row) =>
          paletteScore(
            row.label,
            [...row.keywords, ...row.keys.map((key) => key.glyph)],
            search,
          ) > 0,
      ),
    }))
    .filter((section) => section.rows.length > 0);

  // Shift alone is typing capitals, not the start of a chord.
  const chording = held.mod || held.alt;
  const showEntrance = entrance && !entered.current;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-4 pb-8">
      <div
        ref={listRef}
        className="mx-auto flex w-full max-w-3xl flex-col gap-6"
      >
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-lg font-semibold">
              {t("shortcutsPage.title")}
            </h1>
            <p className="text-xs text-muted-foreground">
              {t("shortcutsPage.description")}
            </p>
          </div>
          <button
            type="button"
            data-slot="shortcuts-open-palette"
            onClick={onOpenPalette}
            onPointerEnter={playDemo}
            className="flex shrink-0 cursor-pointer items-center gap-3 rounded-lg bg-foreground/5 px-3 py-2 text-left transition-colors hover:bg-foreground/10"
          >
            <KbdGroup
              keys={paletteKeys}
              size="md"
              pressed={(index) =>
                index < demo ||
                (chording && modifierHeld(paletteKeys[index], held)) ||
                (tapped === "openPalette" && index === chordLength - 1)
              }
            />
            <span className="flex flex-col">
              <span className="text-sm font-medium">
                {t("shortcuts.openPalette")}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("shortcutsPage.paletteHint")}
              </span>
            </span>
          </button>
        </header>

        <div className="flex flex-col gap-2">
          <Input
            data-slot="shortcuts-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              // Escape empties the filter before it can close the page.
              if (event.key === "Escape" && search) {
                event.preventDefault();
                event.stopPropagation();
                setSearch("");
              }
            }}
            aria-label={t("appFeedback.searchShortcuts")}
            placeholder={t("appFeedback.searchShortcuts")}
          />
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <KbdGroup
              keys={holdKeys}
              pressed={(index) =>
                chording && modifierHeld(holdKeys[index], held)
              }
            />
            {t("shortcutsPage.holdHint")}
          </p>
        </div>

        {sections.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("common.noResults")}
          </p>
        )}
        {sections.map((section, index) => (
          <motion.section
            key={section.id}
            data-slot="shortcuts-section"
            data-section={section.id}
            className="flex flex-col gap-2"
            initial={showEntrance ? { opacity: 0, y: 6 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.22,
              delay: showEntrance ? index * 0.05 : 0,
              ease: MOTION_EASE_OUT,
            }}
          >
            <h2 className="text-[10px] tracking-wide text-muted-foreground uppercase">
              {section.title}
            </h2>
            <div className="divide-y divide-border overflow-hidden rounded-md border bg-card">
              {section.rows.map((row) => {
                const dimmed = chording && !acceptsHeld(row, held);
                return (
                  <div
                    key={row.id}
                    data-shortcut-row={row.id}
                    data-dimmed={dimmed ? "true" : undefined}
                    className={cn(
                      "relative flex items-center justify-between gap-4 px-3 py-2 transition-opacity duration-150",
                      dimmed && "opacity-40",
                    )}
                  >
                    {hit?.id === row.id ? (
                      <motion.span
                        key={hit.at}
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 bg-primary/10"
                        initial={{ opacity: 1 }}
                        animate={{ opacity: 0 }}
                        transition={{ duration: 0.9, ease: MOTION_EASE_OUT }}
                      />
                    ) : null}
                    <MatchText
                      text={row.label}
                      search={search}
                      className="relative min-w-0 text-sm break-words"
                    />
                    <KbdGroup
                      keys={row.keys}
                      size="md"
                      className="relative"
                      pressed={(keyIndex) => {
                        const token = row.keys[keyIndex];
                        if (
                          token.name === null ||
                          keyIndex === row.keys.length - 1
                        ) {
                          return tapped === row.id;
                        }
                        return chording && modifierHeld(token, held);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </motion.section>
        ))}
      </div>
    </div>
  );
}
