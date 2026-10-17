"use client";

import { motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  LuCircleAlert,
  LuCircleHelp,
  LuHistory,
  LuSearch,
  LuX,
} from "react-icons/lu";
import { tipAnchor } from "@/lib/coach-mark";
import { MOTION_EASE_OUT, MOTION_SPRING_POSITION } from "@/lib/motion";
import {
  findProfileSearchField,
  PROFILE_SEARCH_EXAMPLES,
  PROFILE_SEARCH_FIELDS,
  PROFILE_SEARCH_OPERATORS,
  type ProfileSearchContext,
} from "@/lib/profile-search";
import {
  analyzeProfileSearch,
  applyProfileSearchSuggestion,
  buildProfileSearchVocabulary,
  countProfileSearchMatches,
  insertProfileSearchTerm,
  type ProfileSearchIssue,
  type ProfileSearchSpanKind,
  type ProfileSearchSuggestion,
  type ProfileSearchSuggestionKind,
  type ProfileSearchSuggestions,
  type ProfileSearchVocabulary,
  rememberProfileSearch,
  suggestProfileSearch,
} from "@/lib/profile-search-suggest";
import { keyToken } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import type { BrowserProfile } from "@/types";
import { FadingScrollArea } from "./ui/fading-scroll-area";
import { Input } from "./ui/input";
import { Kbd, KbdGroup } from "./ui/kbd";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "./ui/popover";

const RECENT_KEY = "donut-profile-search-recent";
/** A query left alone this long, with results, is one worth finding again. */
const RECENT_IDLE_MS = 3000;
/** Time one slice of count work may take before it yields to typing. */
const COUNT_SLICE_MS = 4;

const NO_VOCABULARY: ProfileSearchVocabulary = new Map();

const NO_PROFILES: readonly BrowserProfile[] = [];
const EMPTY_CONTEXT: ProfileSearchContext = {
  groupNames: new Map(),
  proxyNames: new Map(),
  vpnNames: new Map(),
  extensionGroupNames: new Map(),
  statusNames: new Map(),
  runningProfiles: new Set(),
};

/** Colours only: a weight or style would change glyph widths and pull the text off the caret. */
const SPAN_CLASS: Record<ProfileSearchSpanKind, string> = {
  space: "",
  text: "text-foreground",
  value: "text-foreground",
  field: "text-muted-foreground",
  operator: "text-warning",
  reserved: "text-warning",
  quoted: "text-success",
  negate: "text-destructive",
};

const ISSUE_CLASS =
  "underline decoration-destructive/70 decoration-wavy underline-offset-[3px]";

/** Rows that end in a whole query, so they can say how many profiles it finds. */
const COUNTED = new Set<ProfileSearchSuggestionKind>([
  "value",
  "match",
  "recent",
  "example",
]);

function loadRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(RECENT_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function saveRecent(recent: readonly string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {}
}

function QueryText({ query }: { query: string }) {
  const { spans } = useMemo(() => analyzeProfileSearch(query), [query]);
  return (
    <>
      {spans.map((span) => (
        <span key={span.start} className={SPAN_CLASS[span.kind]}>
          {query.slice(span.start, span.end)}
        </span>
      ))}
    </>
  );
}

/**
 * How many profiles each row's finished query finds. Counted a few at a time
 * after the keystroke has painted, and kept per query until the profiles or
 * their names change, so typing and moving the caret never wait on a count.
 */
function useSuggestionCounts(
  queries: readonly string[],
  pool: readonly BrowserProfile[],
  context: ProfileSearchContext,
  enabled: boolean,
): ReadonlyMap<string, number> {
  const cache = useRef<{
    pool: readonly BrowserProfile[];
    context: ProfileSearchContext;
    counts: Map<string, number>;
  } | null>(null);
  const [, setVersion] = useState(0);
  if (
    !cache.current ||
    cache.current.pool !== pool ||
    cache.current.context !== context
  ) {
    cache.current = { pool, context, counts: new Map() };
  }
  const counts = cache.current.counts;
  const pendingKey = enabled
    ? [...new Set(queries)].filter((query) => !counts.has(query)).join("\n")
    : "";

  useEffect(() => {
    if (pendingKey.length === 0) return;
    const pending = pendingKey.split("\n");
    let timer = 0;
    const step = () => {
      const until = performance.now() + COUNT_SLICE_MS;
      while (pending.length > 0 && performance.now() < until) {
        const query = pending.shift() as string;
        counts.set(query, countProfileSearchMatches(pool, query, context));
      }
      setVersion((version) => version + 1);
      if (pending.length > 0) timer = window.setTimeout(step, 0);
    };
    timer = window.setTimeout(step, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [pendingKey, counts, pool, context]);

  return counts;
}

interface SearchSyntaxHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsertField: (key: string) => void;
  onUseExample: (query: string) => void;
  onCloseAutoFocus: (event: Event) => void;
}

/**
 * What the search box understands. The vocabulary is data owned by the parser
 * (`src/lib/profile-search.ts`), so the tokens listed here cannot drift from the
 * ones a query is actually matched against; only the prose beside them is
 * translated, because the tokens themselves have to mean the same thing to
 * everybody who is handed a query.
 */
function SearchSyntaxHelp({
  open,
  onOpenChange,
  onInsertField,
  onUseExample,
  onCloseAutoFocus,
}: SearchSyntaxHelpProps) {
  const { t } = useTranslation();
  const row =
    "-mx-1 rounded-sm px-1 py-0.5 text-left transition-colors duration-100 hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:outline-none";

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("search.helpLabel")}
          className="grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors duration-100 hover:bg-foreground/5 hover:text-foreground"
        >
          <LuCircleHelp className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        data-slot="profile-search-help"
        onCloseAutoFocus={onCloseAutoFocus}
        className="w-96 max-w-[calc(100vw-1.5rem)] p-0"
      >
        <div className="space-y-3 p-3 text-xs">
          <div>
            <p className="font-medium text-foreground">
              {t("search.helpTitle")}
            </p>
            <p className="mt-1 text-muted-foreground">
              {t("search.helpIntro")}
            </p>
          </div>

          <div>
            <p className="font-medium text-foreground">
              {t("search.fieldsTitle")}
            </p>
            <div className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3">
              {PROFILE_SEARCH_FIELDS.map((field) => (
                <button
                  key={field.key}
                  type="button"
                  data-search-field={field.key}
                  onClick={() => {
                    onInsertField(field.key);
                  }}
                  className={cn(
                    "col-span-2 grid grid-cols-subgrid items-baseline",
                    row,
                  )}
                >
                  <code className="font-mono text-[11px] text-foreground">
                    {field.key}:
                  </code>
                  <span className="text-muted-foreground">
                    {t(field.labelKey)}
                    {field.values ? (
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/70">
                        {field.values.join(" ")}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="font-medium text-foreground">
              {t("search.operatorsTitle")}
            </p>
            <div className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {PROFILE_SEARCH_OPERATORS.map((operator) => (
                <div key={operator.labelKey} className="contents">
                  <code className="font-mono text-[11px]">
                    <QueryText query={operator.token} />
                  </code>
                  <span className="text-muted-foreground">
                    {t(operator.labelKey)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="font-medium text-foreground">
              {t("search.examplesTitle")}
            </p>
            <div className="mt-1.5 flex flex-col">
              {PROFILE_SEARCH_EXAMPLES.map((example) => (
                <button
                  key={example.labelKey}
                  type="button"
                  data-search-example={example.query}
                  onClick={() => {
                    onUseExample(example.query);
                  }}
                  className={cn("py-1", row)}
                >
                  <code className="block font-mono text-[11px]">
                    <QueryText query={example.query} />
                  </code>
                  <span className="text-muted-foreground">
                    {t(example.labelKey)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface ProfileSearchInputProps {
  value: string;
  onChange: (query: string) => void;
  /** The profiles the search runs over: the source of values and counts. */
  profiles?: readonly BrowserProfile[];
  context?: ProfileSearchContext;
}

type Section = {
  key: string;
  title: string;
  items: { item: ProfileSearchSuggestion; index: number }[];
};

/**
 * The profile search box: the native input carries the text and the caret,
 * and a copy drawn under it colours the syntax, marks a term the parser drops
 * or reads as text, and shows the completion after the caret.
 */
export function ProfileSearchInput({
  value,
  onChange,
  profiles,
  context = EMPTY_CONTEXT,
}: ProfileSearchInputProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-option-${index}`;
  const pool = profiles ?? NO_PROFILES;

  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const focusInputOnHelpClose = useRef(false);
  const stayClosedOnFocus = useRef(false);
  const settleCount = useRef(0);
  const revealActive = useRef(false);

  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [collapsed, setCollapsed] = useState(true);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [settle, setSettle] = useState<{
    start: number;
    end: number;
    key: number;
  } | null>(null);

  useEffect(() => {
    saveRecent(recent);
  }, [recent]);

  const analysis = useMemo(() => analyzeProfileSearch(value), [value]);
  const vocabulary = useMemo(
    () =>
      focused ? buildProfileSearchVocabulary(pool, context) : NO_VOCABULARY,
    [focused, pool, context],
  );
  const suggestions = useMemo<ProfileSearchSuggestions>(
    () =>
      focused
        ? suggestProfileSearch(
            value,
            Math.min(caret, value.length),
            vocabulary,
            { recent },
          )
        : { items: [] },
    [focused, value, caret, vocabulary, recent],
  );
  const items = suggestions.items;
  const issue = suggestions.issue;
  const open =
    focused &&
    !dismissed &&
    !helpOpen &&
    (items.length > 0 || issue !== undefined);

  // A different list resets the keyboard choice, as a new list would.
  const itemsKey = items.map((item) => item.id).join("\n");
  const [activeFor, setActiveFor] = useState(itemsKey);
  if (activeFor !== itemsKey) {
    setActiveFor(itemsKey);
    setActive(null);
  }
  const activeIndex = active !== null && active < items.length ? active : null;
  const activeItem = activeIndex !== null ? items[activeIndex] : undefined;
  const ghostItem = activeItem ?? items.find((item) => item.ghost);
  const ghost =
    open && collapsed && !composing && ghostItem ? ghostItem.ghost : "";

  const counts = useSuggestionCounts(
    items.filter((item) => COUNTED.has(item.kind)).map((item) => item.query),
    pool,
    context,
    open && profiles !== undefined,
  );

  const syncScroll = useCallback(() => {
    const input = inputRef.current;
    const text = textRef.current;
    if (input && text) {
      text.style.transform = `translateX(${-input.scrollLeft}px)`;
    }
  }, []);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input && pendingCaret.current !== null) {
      const at = Math.min(pendingCaret.current, input.value.length);
      pendingCaret.current = null;
      input.setSelectionRange(at, at);
    }
    syncScroll();
  });

  useEffect(() => {
    if (!revealActive.current || activeIndex === null) return;
    revealActive.current = false;
    document
      .getElementById(optionId(activeIndex))
      ?.scrollIntoView({ block: "nearest" });
  });

  const readCaret = () => {
    const input = inputRef.current;
    if (!input) return;
    setCaret(input.selectionStart ?? input.value.length);
    setCollapsed(input.selectionStart === input.selectionEnd);
    syncScroll();
  };

  const remember = useCallback((query: string) => {
    setRecent((list) => {
      const next = rememberProfileSearch(list, query);
      return next.join("\n") === list.join("\n") ? list : next;
    });
  }, []);

  const latest = useRef({ pool, context });
  useEffect(() => {
    latest.current = { pool, context };
  });
  useEffect(() => {
    if (profiles === undefined || value.trim().length === 0) return;
    const timer = window.setTimeout(() => {
      const { pool: profilesNow, context: contextNow } = latest.current;
      if (countProfileSearchMatches(profilesNow, value, contextNow) > 0) {
        remember(value);
      }
    }, RECENT_IDLE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [value, profiles, remember]);

  const clearRecent = () => {
    setRecent([]);
  };

  const setQuery = (query: string, at: number) => {
    pendingCaret.current = at;
    setCaret(at);
    setCollapsed(true);
    setActive(null);
    onChange(query);
  };

  const accept = (item: ProfileSearchSuggestion) => {
    const next = applyProfileSearchSuggestion(value, item);
    setQuery(next.query, next.caret);
    setDismissed(item.completes);
    setSettle(
      reduceMotion
        ? null
        : {
            start: item.start,
            end: item.start + item.text.trimEnd().length,
            key: ++settleCount.current,
          },
    );
    if (item.completes) remember(next.query);
    inputRef.current?.focus();
  };

  const closeHelpToInput = () => {
    focusInputOnHelpClose.current = true;
    setHelpOpen(false);
  };

  const insertField = (key: string) => {
    const next = insertProfileSearchTerm(value, caret, `${key}:`);
    setQuery(next.query, next.caret);
    setDismissed(false);
    closeHelpToInput();
  };

  const pickExample = (query: string) => {
    setQuery(query, query.length);
    remember(query);
    stayClosedOnFocus.current = true;
    setDismissed(true);
    closeHelpToInput();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    // WebKit reports the key that commits an IME composition as keyCode 229.
    if (
      composing ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    ) {
      return;
    }
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (items.length === 0) return;
        event.preventDefault();
        if (!open) {
          setDismissed(false);
          return;
        }
        const step = event.key === "ArrowDown" ? 1 : -1;
        revealActive.current = true;
        setActive(
          activeIndex === null
            ? step > 0
              ? 0
              : items.length - 1
            : (activeIndex + step + items.length) % items.length,
        );
        return;
      }
      case "Tab": {
        if (event.shiftKey || !open) return;
        const item = activeItem ?? (ghost ? ghostItem : undefined);
        if (!item) return;
        event.preventDefault();
        accept(item);
        return;
      }
      case "ArrowRight": {
        if (!ghost || !ghostItem) return;
        event.preventDefault();
        accept(ghostItem);
        return;
      }
      case "Enter": {
        if (open && activeItem) {
          event.preventDefault();
          accept(activeItem);
          return;
        }
        remember(value);
        setDismissed(true);
        return;
      }
      case "Escape": {
        if (!open) return;
        event.preventDefault();
        event.stopPropagation();
        setDismissed(true);
        setActive(null);
        return;
      }
    }
  };

  const caretToken = focused
    ? analysis.tokens.findIndex(
        (token) => token.start < caret && caret <= token.end,
      )
    : -1;
  const highlighted: ReactNode[] = [];
  for (const span of analysis.spans) {
    const token =
      span.token !== undefined ? analysis.tokens[span.token] : undefined;
    const className = cn(
      SPAN_CLASS[span.kind],
      token?.issue && span.token !== caretToken && ISSUE_CLASS,
    );
    const cuts = [span.start, span.end];
    if (settle) {
      for (const edge of [settle.start, settle.end]) {
        if (edge > span.start && edge < span.end) cuts.splice(-1, 0, edge);
      }
    }
    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i];
      const to = cuts[i + 1];
      const text = value.slice(from, to);
      if (settle && from >= settle.start && to <= settle.end) {
        highlighted.push(
          <motion.span
            key={`${settle.key}-${from}`}
            className={className}
            initial={{ opacity: 0.4 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18, ease: MOTION_EASE_OUT }}
          >
            {text}
          </motion.span>,
        );
      } else {
        highlighted.push(
          <span key={from} className={className}>
            {text}
          </span>,
        );
      }
    }
  }

  const sections: Section[] = [];
  items.forEach((item, index) => {
    const key = item.kind === "value" ? `value:${item.field}` : item.kind;
    const last = sections[sections.length - 1];
    if (last && last.key === key) {
      last.items.push({ item, index });
      return;
    }
    const field = item.field ? findProfileSearchField(item.field) : undefined;
    const title =
      item.kind === "value" && field
        ? t(field.labelKey)
        : item.kind === "field"
          ? t("search.fieldsTitle")
          : item.kind === "operator"
            ? t("search.operatorsTitle")
            : item.kind === "match"
              ? t("search.suggest.matches")
              : item.kind === "recent"
                ? t("search.suggest.recent")
                : t("search.examplesTitle");
    sections.push({ key, title, items: [{ item, index }] });
  });

  const issueText = (problem: ProfileSearchIssue) => {
    switch (problem.code) {
      case "unknownField":
        return t("search.issues.unknownField", {
          name: problem.name,
          field: `${problem.field}:`,
        });
      case "compare":
        return t("search.issues.compare", { field: `${problem.field}:` });
      case "date":
        return t("search.issues.date", { field: `${problem.field}:` });
      case "enum":
        return t("search.issues.enum", {
          field: `${problem.field}:`,
          values: problem.values.join(", "),
        });
      case "boolean":
        return t("search.issues.boolean", { field: `${problem.field}:` });
    }
  };

  const renderRow = (item: ProfileSearchSuggestion) => {
    switch (item.kind) {
      case "field":
      case "operator":
        return (
          <>
            <code className="shrink-0 font-mono text-[11px]">
              <QueryText query={item.label} />
            </code>
            {item.descriptionKey ? (
              <span className="truncate text-muted-foreground">
                {t(item.descriptionKey)}
              </span>
            ) : null}
          </>
        );
      case "match":
        return (
          <span className="min-w-0 truncate">
            <span className="font-mono text-[11px] text-muted-foreground">
              {item.field}:
            </span>
            {item.label}
          </span>
        );
      case "recent":
        return (
          <>
            <LuHistory className="size-3.5 shrink-0 text-muted-foreground" />
            <code className="min-w-0 truncate font-mono text-[11px]">
              <QueryText query={item.label} />
            </code>
          </>
        );
      case "example":
        return (
          <span className="flex min-w-0 flex-col">
            <code className="truncate font-mono text-[11px]">
              <QueryText query={item.label} />
            </code>
            {item.descriptionKey ? (
              <span className="truncate text-muted-foreground">
                {t(item.descriptionKey)}
              </span>
            ) : null}
          </span>
        );
      default:
        return (
          <>
            <span
              className={cn(
                "min-w-0 truncate",
                item.descriptionKey && "shrink-0 font-mono text-[11px]",
              )}
            >
              {item.label}
            </span>
            {item.descriptionKey ? (
              <span className="truncate text-muted-foreground">
                {t(item.descriptionKey)}
              </span>
            ) : null}
          </>
        );
    }
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setDismissed(true);
            setActive(null);
          }
        }}
      >
        <PopoverAnchor asChild>
          <div
            ref={wrapperRef}
            data-slot="profile-search"
            {...tipAnchor("profile-search")}
            className="relative h-7 w-36 shrink-0 rounded-lg bg-foreground/5 transition-[width,background-color,box-shadow] duration-200 ease-out focus-within:w-56 focus-within:bg-foreground/7 focus-within:ring-2 focus-within:ring-foreground/15 hover:bg-foreground/7 motion-reduce:transition-none min-[860px]:w-52 min-[860px]:focus-within:w-80"
          >
            <LuSearch className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-7 left-8 overflow-hidden"
            >
              <div
                ref={textRef}
                data-slot="profile-search-highlight"
                className="whitespace-pre text-xs leading-7"
              >
                {highlighted}
                {ghost ? (
                  <span
                    data-slot="profile-search-ghost"
                    className="text-muted-foreground/60"
                  >
                    {ghost}
                  </span>
                ) : null}
              </div>
            </div>
            <Input
              ref={inputRef}
              type="text"
              variant="bare"
              role="combobox"
              aria-autocomplete="both"
              aria-expanded={open}
              aria-controls={open && items.length > 0 ? listId : undefined}
              aria-activedescendant={
                open && activeIndex !== null ? optionId(activeIndex) : undefined
              }
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={t("header.searchPlaceholder")}
              value={value}
              onChange={(event) => {
                onChange(event.target.value);
                setDismissed(false);
                setActive(null);
                setSettle(null);
                readCaret();
              }}
              onSelect={readCaret}
              onScroll={syncScroll}
              onKeyDown={onKeyDown}
              onMouseDown={() => {
                setDismissed(false);
              }}
              onFocus={() => {
                setFocused(true);
                setDismissed(stayClosedOnFocus.current);
                stayClosedOnFocus.current = false;
                readCaret();
              }}
              onBlur={() => {
                setFocused(false);
                setActive(null);
                setSettle(null);
              }}
              onCompositionStart={() => {
                setComposing(true);
              }}
              onCompositionEnd={() => {
                setComposing(false);
              }}
              className="relative h-7 rounded-lg pr-7 pl-8 text-xs text-transparent caret-foreground selection:bg-primary/25 selection:text-transparent md:text-xs"
            />
            {value ? (
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  setQuery("", 0);
                  setDismissed(false);
                  inputRef.current?.focus();
                }}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-0.5 transition-colors hover:bg-foreground/10"
                aria-label={t("header.clearSearch")}
              >
                <LuX className="size-3.5 text-muted-foreground hover:text-foreground" />
              </button>
            ) : null}
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="end"
          sideOffset={6}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (wrapperRef.current?.contains(event.target as Node)) {
              event.preventDefault();
            }
          }}
          className="w-88 max-w-[calc(100vw-1.5rem)] overflow-visible rounded-none border-0 bg-transparent p-0 shadow-none"
        >
          <motion.div
            data-slot="profile-search-suggestions"
            initial={
              reduceMotion
                ? { opacity: 0 }
                : { opacity: 0, transform: "translateY(-4px) scale(0.98)" }
            }
            animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
            transition={{ duration: 0.14, ease: MOTION_EASE_OUT }}
            style={{
              transformOrigin: "var(--radix-popover-content-transform-origin)",
            }}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            className="overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
          >
            {issue ? (
              <div
                data-slot="profile-search-issue"
                role="status"
                className="flex items-start gap-2 border-b border-border px-3 py-2 text-xs text-destructive"
              >
                <LuCircleAlert className="mt-px size-3.5 shrink-0" />
                <span>{issueText(issue)}</span>
              </div>
            ) : null}
            {items.length > 0 ? (
              <FadingScrollArea
                id={listId}
                role="listbox"
                aria-label={t("search.suggest.label")}
                className="max-h-72 p-1"
                onPointerLeave={() => {
                  setActive(null);
                }}
              >
                {sections.map((section) => (
                  <div
                    key={section.key}
                    role="group"
                    aria-labelledby={`${id}-${section.key}`}
                  >
                    <div
                      id={`${id}-${section.key}`}
                      className="flex items-center justify-between px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground"
                    >
                      <span className="truncate">{section.title}</span>
                      {section.key === "recent" ? (
                        <button
                          type="button"
                          onClick={clearRecent}
                          className="rounded-sm px-1 text-[11px] font-normal transition-colors duration-100 hover:text-foreground"
                        >
                          {t("common.buttons.clear")}
                        </button>
                      ) : null}
                    </div>
                    {section.items.map(({ item, index }) => {
                      const count = COUNTED.has(item.kind)
                        ? counts.get(item.query)
                        : undefined;
                      const selected = index === activeIndex;
                      return (
                        <div
                          key={item.id}
                          id={optionId(index)}
                          role="option"
                          tabIndex={-1}
                          aria-selected={selected}
                          data-suggestion-kind={item.kind}
                          data-suggestion={item.text.trimEnd()}
                          onPointerMove={() => {
                            if (!selected) setActive(index);
                          }}
                          onClick={() => {
                            accept(item);
                          }}
                          onKeyDown={onKeyDown}
                          className="relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs"
                        >
                          {selected ? (
                            <motion.div
                              layoutId={`${id}-active`}
                              data-slot="profile-search-active"
                              className="absolute inset-0 rounded-md bg-primary/10"
                              transition={
                                reduceMotion
                                  ? { duration: 0 }
                                  : MOTION_SPRING_POSITION
                              }
                            />
                          ) : null}
                          <span className="relative flex min-w-0 flex-1 items-center gap-2">
                            {renderRow(item)}
                          </span>
                          {count !== undefined ? (
                            <span className="relative shrink-0 pl-2 text-[11px] text-muted-foreground tabular-nums">
                              <span
                                aria-hidden="true"
                                data-slot="profile-search-count"
                              >
                                {count}
                              </span>
                              <span className="sr-only">
                                {t("groupManagement.profileCount", { count })}
                              </span>
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </FadingScrollArea>
            ) : null}
            <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <KbdGroup keys={[keyToken("up"), keyToken("down")]} />
                {t("search.suggest.keys.choose")}
              </span>
              <span className="flex items-center gap-1">
                <Kbd token={{ glyph: t("common.keys.tab"), name: null }} />
                {t("search.suggest.keys.complete")}
              </span>
              <button
                type="button"
                data-slot="profile-search-syntax"
                onClick={() => {
                  setHelpOpen(true);
                }}
                className="ml-auto flex items-center gap-1 rounded-sm transition-colors duration-100 hover:text-foreground"
              >
                <LuCircleHelp className="size-3" />
                {t("search.helpTitle")}
              </button>
            </div>
          </motion.div>
        </PopoverContent>
      </Popover>
      <SearchSyntaxHelp
        open={helpOpen}
        onOpenChange={setHelpOpen}
        onInsertField={insertField}
        onUseExample={pickExample}
        onCloseAutoFocus={(event) => {
          if (!focusInputOnHelpClose.current) return;
          focusInputOnHelpClose.current = false;
          event.preventDefault();
          inputRef.current?.focus();
        }}
      />
    </>
  );
}
