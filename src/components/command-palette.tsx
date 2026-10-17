"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaDownload } from "react-icons/fa";
import { FiWifi } from "react-icons/fi";
import { GoGear } from "react-icons/go";
import {
  LuArrowLeft,
  LuBadgeInfo,
  LuBot,
  LuChevronRight,
  LuCircleStop,
  LuCloud,
  LuCookie,
  LuInfo,
  LuKeyboard,
  LuKeyRound,
  LuLightbulb,
  LuMessageSquareHeart,
  LuPlay,
  LuPlug,
  LuPlus,
  LuPuzzle,
  LuSearchX,
  LuTrash2,
  LuUser,
  LuUsers,
} from "react-icons/lu";

import {
  CommandDialog,
  CommandEmpty,
  CommandGlide,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { KbdGroup } from "@/components/ui/kbd";
import { MatchText } from "@/components/ui/match-text";
import { MOTION_EASE_OUT } from "@/lib/motion";
import {
  paletteScore,
  parseRecents,
  RECENT_SHOWN,
  rememberRecent,
} from "@/lib/palette-search";
import {
  groupShortcutKeys,
  type KeyToken,
  keyToken,
  matchesGroupDigit,
  matchesShortcut,
  SHORTCUTS,
  type ShortcutDef,
  type ShortcutId,
  shortcutKeys,
} from "@/lib/shortcuts";
import { playUiSound, type UiSound } from "@/lib/ui-sounds";
import type { BrowserProfile } from "@/types";

interface GroupTarget {
  id: string;
  name: string;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (id: ShortcutId) => void;
  /** Ordered list of groups for Mod+1..9. Index 0 is the catch-all entry. */
  groupTargets: GroupTarget[];
  onSelectGroup: (id: string) => void;
  /** All profiles for launch/stop/info entries. */
  profiles: BrowserProfile[];
  runningProfileIds: Set<string>;
  onLaunchProfile: (profile: BrowserProfile) => void;
  onKillProfile: (profile: BrowserProfile) => void;
  onShowProfileInfo: (profile: BrowserProfile) => void;
  onCreateProfile: () => void;
  onOpenAbout: () => void;
}

type Icon = React.ComponentType<{ className?: string }>;

const ICONS: Record<ShortcutId, Icon> = {
  openPalette: LuKeyboard,
  openShortcuts: LuKeyboard,
  openTips: LuLightbulb,
  sendFeedback: LuMessageSquareHeart,
  openTotp: LuKeyRound,
  importProfile: FaDownload,
  goProfiles: LuUser,
  goProxies: FiWifi,
  goExtensions: LuPuzzle,
  goGroups: LuUsers,
  goCookieBot: LuCookie,
  goAgent: LuBot,
  goIntegrations: LuPlug,
  goAccount: LuCloud,
  goSettings: GoGear,
  goTrash: LuTrash2,
};

/** Lists the palette opens into, with a breadcrumb and their own search. */
type PageId = "launch" | "stop" | "info" | "group";

interface PaletteCommand {
  /** Stable across sessions: recent commands are stored by it. */
  id: string;
  label: string;
  /** Muted text after the label, such as the profile's group. */
  detail?: string;
  keywords: string[];
  icon: Icon;
  keys?: KeyToken[];
  /** Opens this page instead of running. */
  page?: PageId;
  run?: () => void;
  /** Played when it runs; null when the action plays its own. */
  sound?: UiSound | null;
  running?: boolean;
}

interface PageEntry {
  id: PageId;
  /** Restored on the way back: the root search and the entry that opened it. */
  search: string;
  entry: string;
}

const RECENT_KEY = "donut.commandPalette.recent";

const PALETTE_SHORTCUT = SHORTCUTS.find((s) => s.id === "openPalette");

// The glide draws the selection, so a selected item stays transparent.
const ITEM_CLASS =
  "data-[selected=true]:bg-transparent data-[selected=true]:text-foreground data-[selected=true]:[&_svg:not([class*='text-'])]:text-foreground";

function readRecents() {
  try {
    return parseRecents(localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

function writeRecents(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Recent commands are a convenience; a full or blocked store loses them.
  }
}

/** cmdk passes the label as the first keyword; see `PaletteItem`. */
function paletteFilter(_value: string, search: string, keywords?: string[]) {
  const [label = "", ...rest] = keywords ?? [];
  return paletteScore(label, rest, search);
}

function PaletteItem({
  command,
  value,
  search,
  onRun,
}: {
  command: PaletteCommand;
  value?: string;
  search: string;
  onRun: (command: PaletteCommand) => void;
}) {
  const { t } = useTranslation();
  const Icon = command.icon;
  return (
    <CommandItem
      value={value ?? command.id}
      keywords={[command.label, ...command.keywords]}
      onSelect={() => {
        onRun(command);
      }}
      className={ITEM_CLASS}
    >
      <Icon />
      <MatchText
        text={command.label}
        search={search}
        className="min-w-0 truncate"
      />
      {command.running ? (
        <span className="size-1.5 shrink-0 rounded-full bg-success">
          <span className="sr-only">{t("common.status.running")}</span>
        </span>
      ) : null}
      {command.detail ? (
        <MatchText
          text={command.detail}
          search={search}
          className="min-w-0 truncate text-xs text-muted-foreground"
        />
      ) : null}
      {command.page ? (
        <LuChevronRight className="ml-auto" />
      ) : command.keys ? (
        <KbdGroup keys={command.keys} className="ml-auto" />
      ) : null}
    </CommandItem>
  );
}

function FooterHint({ keys, label }: { keys: KeyToken[]; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <KbdGroup keys={keys} />
      <span>{label}</span>
    </span>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  onAction,
  groupTargets,
  onSelectGroup,
  profiles,
  runningProfileIds,
  onLaunchProfile,
  onKillProfile,
  onShowProfileInfo,
  onCreateProfile,
  onOpenAbout,
}: CommandPaletteProps) {
  const { t, i18n } = useTranslation();
  const reduceMotion = useReducedMotion();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [pages, setPages] = useState<PageEntry[]>([]);
  // +1 going into a page, -1 coming back; 0 until the first move.
  const [direction, setDirection] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  const page = pages.at(-1)?.id ?? null;

  useEffect(() => {
    if (open) {
      setRecents(readRecents());
      return;
    }
    setSearch("");
    setSelected("");
    setPages([]);
    setDirection(0);
  }, [open]);

  // Synonyms in the current language, plus the English words and label: many
  // people type "proxy" or "settings" whatever language the app is in.
  const english = useMemo(() => i18n.getFixedT("en"), [i18n]);
  const keywordsFor = (key: string, labelKey?: string) => {
    const words = [t(`commandPalette.keywords.${key}`)];
    if (!i18n.language.startsWith("en")) {
      words.push(english(`commandPalette.keywords.${key}`));
      if (labelKey) words.push(english(labelKey));
    }
    return words;
  };

  // Profiles and groups match on what they are called, never on the verb
  // synonyms, or "open" would list every profile.
  const groupName = new Map(groupTargets.map((g) => [g.id, g.name]));
  const profileKeywords = (profile: BrowserProfile) => [
    ...(profile.group_id ? [groupName.get(profile.group_id) ?? ""] : []),
    ...(profile.tags ?? []),
  ];

  /** Launch or stop, whichever the profile's state calls for. */
  const toggleCommand = (
    profile: BrowserProfile,
    bare: boolean,
  ): PaletteCommand => {
    const running = runningProfileIds.has(profile.id);
    return {
      id: `profile:${profile.id}`,
      label: bare
        ? profile.name
        : t(
            running
              ? "commandPalette.actions.stopProfile"
              : "commandPalette.actions.launchProfile",
            { name: profile.name },
          ),
      detail: profile.group_id ? groupName.get(profile.group_id) : undefined,
      keywords: profileKeywords(profile),
      icon: running ? LuCircleStop : LuPlay,
      run: () => {
        if (running) onKillProfile(profile);
        else onLaunchProfile(profile);
      },
      sound: null,
    };
  };

  const infoCommand = (
    profile: BrowserProfile,
    bare: boolean,
  ): PaletteCommand => ({
    id: `info:${profile.id}`,
    label: bare
      ? profile.name
      : t("commandPalette.actions.profileInfo", { name: profile.name }),
    detail: profile.group_id ? groupName.get(profile.group_id) : undefined,
    keywords: profileKeywords(profile),
    icon: LuInfo,
    run: () => {
      onShowProfileInfo(profile);
    },
    sound: "open",
    running: runningProfileIds.has(profile.id),
  });

  const groupCommand = (
    target: GroupTarget,
    index: number,
  ): PaletteCommand => ({
    id: `group:${target.id}`,
    label: target.name,
    keywords: [],
    icon: LuUsers,
    keys: index < 9 ? groupShortcutKeys(index + 1) : undefined,
    run: () => {
      onSelectGroup(target.id);
    },
    sound: "open",
  });

  const shortcutCommand = (s: ShortcutDef): PaletteCommand => ({
    id: `shortcut:${s.id}`,
    label: t(s.labelKey),
    keywords: keywordsFor(s.id, s.labelKey),
    icon: ICONS[s.id],
    keys: shortcutKeys(s),
    run: () => {
      onAction(s.id);
    },
    sound: "open",
  });

  const pageCommand = (id: PageId, icon: Icon): PaletteCommand => ({
    id: `page:${id}`,
    label: t(`commandPalette.pages.${id}.entry`),
    keywords: keywordsFor(id, `commandPalette.pages.${id}.entry`),
    icon,
    page: id,
  });

  const createCommand: PaletteCommand = {
    id: "action:createProfile",
    label: t("commandPalette.actions.createProfile"),
    keywords: keywordsFor(
      "createProfile",
      "commandPalette.actions.createProfile",
    ),
    icon: LuPlus,
    run: onCreateProfile,
    sound: "open",
  };
  const aboutCommand: PaletteCommand = {
    id: "action:about",
    label: t("commandPalette.actions.about"),
    keywords: keywordsFor("about", "commandPalette.actions.about"),
    icon: LuBadgeInfo,
    run: onOpenAbout,
    sound: "open",
  };

  const runningProfiles = profiles.filter((p) => runningProfileIds.has(p.id));
  const stoppedProfiles = profiles.filter((p) => !runningProfileIds.has(p.id));

  const resolveRecent = (id: string): PaletteCommand | null => {
    const [kind, ...rest] = id.split(":");
    const key = rest.join(":");
    switch (kind) {
      case "shortcut": {
        const s = SHORTCUTS.find((entry) => entry.id === key);
        return s && s.id !== "openPalette" ? shortcutCommand(s) : null;
      }
      case "action":
        if (id === createCommand.id) return createCommand;
        return id === aboutCommand.id ? aboutCommand : null;
      case "profile":
      case "info": {
        const profile = profiles.find((p) => p.id === key);
        if (!profile) return null;
        return kind === "info"
          ? infoCommand(profile, false)
          : toggleCommand(profile, false);
      }
      case "group": {
        const index = groupTargets.findIndex((g) => g.id === key);
        return index === -1 ? null : groupCommand(groupTargets[index], index);
      }
      default:
        return null;
    }
  };

  const run = (command: PaletteCommand) => {
    if (command.page) {
      openPage(command.page);
      return;
    }
    const next = rememberRecent(recents, command.id);
    setRecents(next);
    writeRecents(next);
    if (command.sound) playUiSound(command.sound);
    // `cmdk` calls onSelect BEFORE the dialog closes. Close first, then
    // dispatch on the next tick so an action that opens another dialog
    // doesn't race this one's close.
    onOpenChange(false);
    const action = command.run;
    if (action) setTimeout(action, 0);
  };

  const pageCommands = (id: PageId) =>
    id === "launch"
      ? stoppedProfiles.map((p) => toggleCommand(p, true))
      : id === "stop"
        ? runningProfiles.map((p) => toggleCommand(p, true))
        : id === "info"
          ? profiles.map((p) => infoCommand(p, true))
          : groupTargets.map((target, index) => groupCommand(target, index));

  const openPage = (id: PageId) => {
    playUiSound("tap");
    setDirection(1);
    setPages((stack) => [...stack, { id, search, entry: `page:${id}` }]);
    setSearch("");
    // cmdk selects the first item only when nothing is selected, and the
    // entry that opened the page still is when the new items mount.
    setSelected(pageCommands(id)[0]?.id ?? "");
  };

  const closePage = (withSound: boolean) => {
    const top = pages.at(-1);
    if (!top) return;
    if (withSound) playUiSound("tap");
    setDirection(-1);
    setPages(pages.slice(0, -1));
    setSearch(top.search);
    // cmdk selects the first match once the list changes; the entry the
    // person came from goes back to being selected after that.
    setTimeout(() => {
      setSelected(top.entry);
    }, 0);
  };

  /** A close the person asked for, not one that follows a command. */
  const dismiss = (next: boolean) => {
    if (!next) playUiSound("close");
    onOpenChange(next);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const native = event.nativeEvent;
    if (native.isComposing) return;
    if (event.key === "Backspace" && page && !search && !event.repeat) {
      event.preventDefault();
      closePage(true);
      return;
    }
    // Every shortcut works from inside the palette too, and closes it.
    // Stopping the event keeps the app-wide listener from running it again.
    if (PALETTE_SHORTCUT && matchesShortcut(PALETTE_SHORTCUT, native)) {
      event.preventDefault();
      event.stopPropagation();
      dismiss(false);
      return;
    }
    const shortcut = SHORTCUTS.find((s) => matchesShortcut(s, native));
    if (shortcut) {
      event.preventDefault();
      event.stopPropagation();
      run(shortcutCommand(shortcut));
      return;
    }
    const digit = matchesGroupDigit(native);
    if (digit !== null && digit <= groupTargets.length) {
      event.preventDefault();
      event.stopPropagation();
      run(groupCommand(groupTargets[digit - 1], digit - 1));
    }
  };

  const query = search.trim();
  const searching = query.length > 0;

  const item = (command: PaletteCommand, value?: string) => (
    <PaletteItem
      key={value ?? command.id}
      command={command}
      value={value}
      search={search}
      onRun={run}
    />
  );

  const renderRoot = () => {
    const recentCommands = searching
      ? []
      : recents
          .map(resolveRecent)
          .filter((command): command is PaletteCommand => command !== null)
          .slice(0, RECENT_SHOWN);
    const profileEntries = [
      createCommand,
      ...(stoppedProfiles.length > 0 ? [pageCommand("launch", LuPlay)] : []),
      ...(runningProfiles.length > 0
        ? [pageCommand("stop", LuCircleStop)]
        : []),
      ...(profiles.length > 0 ? [pageCommand("info", LuInfo)] : []),
      pageCommand("group", LuUsers),
    ];
    return (
      <>
        {recentCommands.length > 0 ? (
          <CommandGroup
            value="recent"
            heading={t("commandPalette.groups.recent")}
          >
            {recentCommands.map((command) =>
              item(command, `recent:${command.id}`),
            )}
          </CommandGroup>
        ) : null}
        <CommandGroup
          value="profiles"
          heading={t("commandPalette.groups.profiles")}
        >
          {profileEntries.map((command) => item(command))}
          {/* Typing reaches every profile without opening a page first. */}
          {searching
            ? profiles.flatMap((p) => [
                item(toggleCommand(p, false)),
                item(infoCommand(p, false)),
              ])
            : null}
        </CommandGroup>
        {searching ? (
          <CommandGroup
            value="groups"
            heading={t("commandPalette.groups.profileGroups")}
          >
            {groupTargets.map((target, index) =>
              item(groupCommand(target, index)),
            )}
          </CommandGroup>
        ) : null}
        <CommandGroup
          value="navigation"
          heading={t("commandPalette.groups.navigation")}
        >
          {SHORTCUTS.filter((s) => s.group === "navigation").map((s) =>
            item(shortcutCommand(s)),
          )}
        </CommandGroup>
        <CommandGroup
          value="actions"
          heading={t("commandPalette.groups.actions")}
        >
          {SHORTCUTS.filter(
            (s) => s.group === "actions" && s.id !== "openPalette",
          ).map((s) => item(shortcutCommand(s)))}
          {item(aboutCommand)}
        </CommandGroup>
      </>
    );
  };

  const renderPage = (id: PageId) => (
    <CommandGroup value={id}>
      {pageCommands(id).map((command) => item(command))}
    </CommandGroup>
  );

  const pageTitle = page ? t(`commandPalette.pages.${page}.title`) : "";
  const goBack = page !== null;
  const backKey = keyToken(goBack && !search ? "backspace" : "escape");
  const slide = direction !== 0 && !reduceMotion;

  return (
    <CommandDialog
      open={open}
      onOpenChange={dismiss}
      filter={paletteFilter}
      value={selected}
      onValueChange={setSelected}
      loop
      onKeyDown={onKeyDown}
      onEscapeKeyDown={(event) => {
        if (!page) return;
        event.preventDefault();
        closePage(true);
      }}
    >
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={
          page
            ? t(`commandPalette.pages.${page}.placeholder`)
            : t("commandPalette.placeholder")
        }
        leading={
          page ? (
            <motion.button
              key={page}
              type="button"
              data-slot="command-page-chip"
              data-page={page}
              onClick={() => {
                closePage(false);
              }}
              initial={reduceMotion ? false : { scale: 0.85, x: -6 }}
              animate={{ scale: 1, x: 0 }}
              transition={{
                type: "spring",
                stiffness: 600,
                damping: 32,
                mass: 0.5,
              }}
              className="group inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-primary/10 pr-2 pl-1.5 text-xs font-medium whitespace-nowrap text-foreground transition-colors hover:bg-primary/15"
            >
              <LuArrowLeft className="size-3.5 transition-transform duration-150 group-hover:-translate-x-0.5" />
              <span className="sr-only">{t("common.buttons.back")}</span>
              {pageTitle}
            </motion.button>
          ) : null
        }
      />
      <CommandList
        data-sound="off"
        className="h-(--cmdk-list-height) max-h-[min(60vh,480px)] transition-[height] duration-150 ease-out motion-reduce:transition-none"
      >
        <motion.div
          key={page ?? "root"}
          data-slot="command-page"
          data-page={page ?? "root"}
          className="relative"
          initial={slide ? { x: direction * 12 } : false}
          animate={{ x: 0 }}
          transition={{ duration: 0.18, ease: MOTION_EASE_OUT }}
        >
          <CommandGlide />
          <CommandEmpty>
            <div className="flex flex-col items-center gap-1.5 px-6 py-2">
              <LuSearchX className="size-5 text-muted-foreground" />
              <p className="text-sm text-foreground">
                {searching
                  ? t("commandPalette.emptyFor", { query })
                  : t(`commandPalette.pages.${page ?? "launch"}.empty`)}
              </p>
              {searching ? (
                <p className="text-xs text-muted-foreground">
                  {page
                    ? t("commandPalette.emptyPageHint")
                    : t("commandPalette.emptyHint")}
                </p>
              ) : null}
            </div>
          </CommandEmpty>
          {page ? renderPage(page) : renderRoot()}
        </motion.div>
      </CommandList>
      <div
        data-slot="command-footer"
        className="flex h-10 shrink-0 items-center gap-4 border-t px-3 text-xs text-muted-foreground"
      >
        <FooterHint
          keys={[keyToken("up"), keyToken("down")]}
          label={t("commandPalette.footer.move")}
        />
        <FooterHint
          keys={[keyToken("enter")]}
          label={
            selected.startsWith("page:")
              ? t("commandPalette.footer.open")
              : t("commandPalette.footer.run")
          }
        />
        <button
          type="button"
          data-sound="off"
          data-slot="command-footer-back"
          onClick={() => {
            if (goBack) closePage(true);
            else dismiss(false);
          }}
          className="-mr-1.5 ml-auto flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <KbdGroup keys={[backKey]} />
          <span>
            {goBack
              ? t("commandPalette.footer.back")
              : t("commandPalette.footer.close")}
          </span>
        </button>
      </div>
    </CommandDialog>
  );
}
