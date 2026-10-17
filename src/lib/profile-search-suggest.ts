/**
 * Completion, highlighting and history for the profile search box.
 *
 * The grammar lives in `profile-search.ts`; nothing here changes what a query
 * matches. The lexer below repeats `tokenize` and `buildTerm` with positions,
 * so the box can colour each part of a token, mark a token the parser drops or
 * reads as plain text, and offer what fits where the caret is: a field name,
 * a value from the user's own data, an operator, a recent or example query.
 *
 * Free of React and of runtime imports outside `./profile-search`, so
 * `profile-search-suggest.test.mjs` loads it directly.
 */

import type { BrowserProfile } from "@/types";
import {
  findProfileSearchField,
  isProfileSearchBoolean,
  isProfileSearchDate,
  matchesProfile,
  PROFILE_SEARCH_EXAMPLES,
  PROFILE_SEARCH_FIELDS,
  type ProfileSearchContext,
  type ProfileSearchField,
  parseProfileSearch,
  profileSearchFieldValue,
} from "./profile-search";

export type ProfileSearchSpanKind =
  | "space"
  | "text"
  | "negate"
  | "field"
  | "operator"
  | "value"
  | "quoted"
  | "reserved";

export interface ProfileSearchSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: ProfileSearchSpanKind;
  /** Index into `tokens`; absent for the whitespace between them. */
  readonly token?: number;
}

/** Why a token does not do what it looks like it does. */
export type ProfileSearchIssue =
  | {
      readonly code: "unknownField";
      readonly name: string;
      readonly field: string;
    }
  | { readonly code: "compare"; readonly field: string }
  | { readonly code: "date"; readonly field: string }
  | {
      readonly code: "enum";
      readonly field: string;
      readonly values: readonly string[];
    }
  | { readonly code: "boolean"; readonly field: string };

interface Range {
  readonly start: number;
  readonly end: number;
}

interface ValuePiece extends Range {
  readonly text: string;
  readonly quoted: boolean;
}

export interface ProfileSearchToken extends Range {
  readonly negated: boolean;
  /** An `or` joining two terms. */
  readonly keyword: boolean;
  /** An unquoted separator follows the first character. */
  readonly separated: boolean;
  /** The text before the separator, when there is one. */
  readonly name?: Range & { readonly text: string };
  readonly field?: ProfileSearchField;
  readonly separator?: string;
  /** Just past the separator, before any comparison or `=`. */
  readonly afterSeparator?: number;
  /** Just past the separator, comparison and `=`: where the value begins. */
  readonly valueStart?: number;
  readonly exact: boolean;
  readonly quoted: boolean;
  /** The comma-separated values, with their quotes. */
  readonly pieces: readonly ValuePiece[];
  readonly issue?: ProfileSearchIssue;
}

export interface ProfileSearchAnalysis {
  readonly tokens: readonly ProfileSearchToken[];
  /** Covers the whole query, in order. */
  readonly spans: readonly ProfileSearchSpan[];
}

interface LexChar {
  readonly c: string;
  readonly quoted: boolean;
  readonly at: number;
}

interface RawToken extends Range {
  readonly chars: readonly LexChar[];
}

const QUOTE = '"';
const RESERVED = new Set(["none", "any"]);
const COMPARISONS = new Set([">=", "<=", ">", "<"]);
/** Longest first, as in the parser. */
const SEPARATORS = [">=", "<=", "!=", ":", ">", "<"] as const;

/** Splits like the parser's `tokenize`, but keeps where each character was. */
function lex(raw: string): RawToken[] {
  const tokens: RawToken[] = [];
  let start = -1;
  let chars: LexChar[] = [];
  let quoted = false;
  const flush = (end: number) => {
    if (start >= 0) tokens.push({ start, end, chars });
    start = -1;
    chars = [];
  };
  for (let at = 0; at < raw.length; at++) {
    const c = raw[at];
    if (c !== QUOTE && !quoted && /\s/.test(c)) {
      flush(at);
      continue;
    }
    if (start < 0) start = at;
    if (c === QUOTE) {
      quoted = !quoted;
      continue;
    }
    chars.push({ c, quoted, at });
  }
  flush(raw.length);
  return tokens;
}

function textOf(chars: readonly LexChar[]): string {
  let out = "";
  for (const ch of chars) out += ch.c;
  return out;
}

function separatorAt(chars: readonly LexChar[], index: number): string | null {
  for (const sep of SEPARATORS) {
    let hit = true;
    for (let i = 0; i < sep.length; i++) {
      const ch = chars[index + i];
      if (!ch || ch.quoted || ch.c !== sep[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return sep;
  }
  return null;
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** A field the user probably meant, for a name that is not one. */
function nearestField(name: string): string | undefined {
  if (name.length < 2) return undefined;
  for (const field of PROFILE_SEARCH_FIELDS) {
    for (const token of [field.key, ...field.aliases]) {
      if (
        token.startsWith(name) ||
        (name.length >= 3 && withinOneEdit(name, token))
      ) {
        return field.key;
      }
    }
  }
  return undefined;
}

function acceptsEnum(
  field: ProfileSearchField,
  value: string,
  exact: boolean,
  quoted: boolean,
): boolean {
  if (!exact && !quoted && RESERVED.has(value)) return true;
  const slugs = field.values ?? [];
  return exact
    ? slugs.includes(value)
    : slugs.some((slug) => slug.startsWith(value));
}

function isReserved(field: ProfileSearchField, value: string): boolean {
  if (field.kind === "boolean") return false;
  return RESERVED.has(value) || (field.kind === "date" && value === "never");
}

/** Reads one token the way `buildTerm` does, marking what each character is. */
function readToken(
  tok: RawToken,
  kinds: ProfileSearchSpanKind[] | null,
): ProfileSearchToken {
  const mark = (ch: LexChar, kind: ProfileSearchSpanKind) => {
    if (kinds) kinds[ch.at] = kind;
  };
  const base = {
    start: tok.start,
    end: tok.end,
    negated: false,
    keyword: false,
    separated: false,
    exact: false,
    quoted: false,
    pieces: [] as ValuePiece[],
  };
  let body = tok.chars;
  if (body.length === 0) return base;
  if (!body.some((ch) => ch.quoted) && textOf(body).toLowerCase() === "or") {
    for (const ch of body) mark(ch, "operator");
    return { ...base, keyword: true };
  }

  let negated = false;
  const first = body[0];
  if (
    body.length > 1 &&
    !first.quoted &&
    (first.c === "-" || first.c === "!")
  ) {
    negated = true;
    mark(first, "negate");
    body = body.slice(1);
  }

  let found: { at: number; sep: string } | null = null;
  for (let i = 0; i < body.length && !found; i++) {
    if (body[i].quoted) continue;
    const sep = separatorAt(body, i);
    if (sep) found = { at: i, sep };
  }

  const asText = (
    extra: Partial<ProfileSearchToken> = {},
  ): ProfileSearchToken => {
    for (const ch of body) mark(ch, ch.quoted ? "quoted" : "text");
    return { ...base, negated, separated: found !== null, ...extra };
  };
  if (!found || found.at === 0) return asText();

  const nameChars = body.slice(0, found.at);
  const name = {
    start: nameChars[0].at,
    end: body[found.at].at,
    text: textOf(nameChars),
  };
  const field = findProfileSearchField(name.text);
  if (!field) {
    const near = nearestField(name.text.toLowerCase());
    return asText({
      name,
      issue: near
        ? { code: "unknownField", name: name.text, field: near }
        : undefined,
    });
  }

  const sepChars = body.slice(found.at, found.at + found.sep.length);
  let value = body.slice(found.at + found.sep.length);
  let separator = found.sep;
  let opChars: readonly LexChar[] = [];
  if (found.sep === ":") {
    const inner = separatorAt(value, 0);
    if (inner && COMPARISONS.has(inner)) {
      separator = inner;
      opChars = value.slice(0, inner.length);
      value = value.slice(inner.length);
    }
  }
  if (
    COMPARISONS.has(separator) &&
    field.kind !== "date" &&
    field.kind !== "version"
  ) {
    return asText({ name, issue: { code: "compare", field: field.key } });
  }

  if (found.sep === "!=") negated = !negated;
  for (const ch of nameChars) mark(ch, "field");
  for (const ch of sepChars) mark(ch, found.sep === ":" ? "field" : "operator");
  for (const ch of opChars) mark(ch, "operator");
  const afterSeparator = sepChars[sepChars.length - 1].at + 1;
  let last = opChars.length > 0 ? opChars[opChars.length - 1] : null;

  let exact = false;
  const lead = value[0];
  if (lead && !lead.quoted && lead.c === "=") {
    exact = true;
    mark(lead, "operator");
    last = lead;
    value = value.slice(1);
  }
  const valueStart = last ? last.at + 1 : afterSeparator;

  const quoted = value.some((ch) => ch.quoted);
  const pieces: ValuePiece[] = [];
  if (quoted) {
    pieces.push({
      start: valueStart,
      end: tok.end,
      text: textOf(value),
      quoted,
    });
  } else {
    let current: LexChar[] = [];
    let pieceStart = valueStart;
    for (const ch of value) {
      if (ch.c === ",") {
        mark(ch, "operator");
        if (current.length > 0) {
          pieces.push({
            start: pieceStart,
            end: ch.at,
            text: textOf(current),
            quoted,
          });
        }
        current = [];
        pieceStart = ch.at + 1;
        continue;
      }
      current.push(ch);
    }
    if (current.length > 0) {
      pieces.push({
        start: pieceStart,
        end: tok.end,
        text: textOf(current),
        quoted,
      });
    }
  }
  if (kinds) {
    for (const piece of pieces) {
      const reserved =
        !quoted && !exact && isReserved(field, piece.text.toLowerCase());
      for (let at = piece.start; at < piece.end; at++) {
        if (kinds[at] === "operator") continue;
        kinds[at] = quoted ? "quoted" : reserved ? "reserved" : "value";
      }
    }
  }

  const values = pieces.map((piece) => piece.text.toLowerCase());
  let issue: ProfileSearchIssue | undefined;
  if (field.kind === "date" && values.some((v) => !isProfileSearchDate(v))) {
    issue = { code: "date", field: field.key };
  } else if (
    field.kind === "boolean" &&
    values.some((v) => !isProfileSearchBoolean(v))
  ) {
    issue = { code: "boolean", field: field.key };
  } else if (
    field.kind === "enum" &&
    values.some((v) => !acceptsEnum(field, v, exact, quoted))
  ) {
    issue = { code: "enum", field: field.key, values: field.values ?? [] };
  }

  return {
    ...base,
    negated,
    separated: true,
    name,
    field,
    separator,
    afterSeparator,
    valueStart,
    exact,
    quoted,
    pieces,
    issue,
  };
}

interface Analysis extends ProfileSearchAnalysis {
  readonly raw: readonly RawToken[];
}

function analyze(query: string): Analysis {
  const kinds = new Array<ProfileSearchSpanKind>(query.length).fill("space");
  const owner = new Array<number>(query.length).fill(-1);
  const raw = lex(query);
  const tokens = raw.map((tok, index) => {
    for (let at = tok.start; at < tok.end; at++) {
      kinds[at] = query[at] === QUOTE ? "quoted" : "text";
      owner[at] = index;
    }
    return readToken(tok, kinds);
  });
  const spans: ProfileSearchSpan[] = [];
  for (let at = 0; at < query.length; at++) {
    const previous = spans[spans.length - 1];
    const token = owner[at] >= 0 ? owner[at] : undefined;
    if (previous && previous.kind === kinds[at] && previous.token === token) {
      spans[spans.length - 1] = { ...previous, end: at + 1 };
    } else {
      spans.push({ start: at, end: at + 1, kind: kinds[at], token });
    }
  }
  return { raw, tokens, spans };
}

/** Colours and checks a query, part by part. */
export function analyzeProfileSearch(query: string): ProfileSearchAnalysis {
  const { tokens, spans } = analyze(query);
  return { tokens, spans };
}

export interface ProfileSearchVocabularyEntry {
  readonly value: string;
  /** Profiles holding the value; 0 for a name nothing uses yet. */
  readonly count: number;
}

/** Real values per field key, most used first. */
export type ProfileSearchVocabulary = ReadonlyMap<
  string,
  readonly ProfileSearchVocabularyEntry[]
>;

const NAME_SOURCES: Readonly<
  Record<string, (ctx: ProfileSearchContext) => ReadonlyMap<string, string>>
> = {
  group: (ctx) => ctx.groupNames,
  state: (ctx) => ctx.statusNames,
  proxy: (ctx) => ctx.proxyNames,
  vpn: (ctx) => ctx.vpnNames,
  ext: (ctx) => ctx.extensionGroupNames,
};

const VOCABULARY_FIELDS = [
  "name",
  "tag",
  "group",
  "state",
  "proxy",
  "vpn",
  "ext",
  "browser",
  "version",
  "email",
];

export function buildProfileSearchVocabulary(
  profiles: readonly BrowserProfile[],
  ctx: ProfileSearchContext,
): ProfileSearchVocabulary {
  const vocabulary = new Map<string, ProfileSearchVocabularyEntry[]>();
  for (const key of VOCABULARY_FIELDS) {
    const field = findProfileSearchField(key);
    if (!field) continue;
    const entries = new Map<string, { value: string; count: number }>();
    const add = (value: string, count: number) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      const id = trimmed.toLowerCase();
      const entry = entries.get(id);
      if (entry) entry.count += count;
      else entries.set(id, { value: trimmed, count });
    };
    const names = NAME_SOURCES[key];
    if (names) for (const name of names(ctx).values()) add(name, 0);
    for (const profile of profiles) {
      for (const value of profileSearchFieldValue(profile, field, ctx)
        .candidates) {
        add(value, 1);
      }
    }
    vocabulary.set(
      key,
      [...entries.values()].sort(
        (a, b) => b.count - a.count || a.value.localeCompare(b.value),
      ),
    );
  }
  return vocabulary;
}

export type ProfileSearchSuggestionKind =
  | "field"
  | "value"
  | "match"
  | "operator"
  | "recent"
  | "example";

export interface ProfileSearchSuggestion {
  readonly id: string;
  readonly kind: ProfileSearchSuggestionKind;
  /** What the row shows: syntax for fields and operators, the value otherwise. */
  readonly label: string;
  /** The field a value, match or field row belongs to. */
  readonly field?: string;
  /** Translation key for the row's description. */
  readonly descriptionKey?: string;
  /** The edit: `text` replaces `query.slice(start, end)`. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Where the caret goes inside `text`. */
  readonly caretOffset: number;
  /** What `text` adds past the caret, shown as ghost text; empty when it does not continue what is typed. */
  readonly ghost: string;
  /** Accepting finishes a term, so the list can close. */
  readonly completes: boolean;
  /** The whole query after accepting. */
  readonly query: string;
}

export interface ProfileSearchSuggestions {
  readonly items: readonly ProfileSearchSuggestion[];
  /** What is wrong with the token under the caret. */
  readonly issue?: ProfileSearchIssue;
}

export interface ProfileSearchSuggestOptions {
  readonly recent?: readonly string[];
  /** Epoch ms for "this year". Defaults to the wall clock. */
  readonly now?: number;
}

export const PROFILE_SEARCH_VALUE_LIMIT = 8;
const MATCH_LIMIT = 5;
const MIN_MATCH_LENGTH = 2;

/** Relations where `none` and `any` ask whether something is set. */
const NONE_ANY_FIELDS = new Set([
  "tag",
  "note",
  "group",
  "state",
  "proxy",
  "vpn",
  "ext",
  "dns",
  "os",
  "email",
]);

/** Fields a bare word is looked up in, to offer `field:value` for it. */
const MATCH_FIELDS = ["group", "state", "tag", "proxy", "vpn", "ext"];

const DATE_TEMPLATES: readonly {
  readonly value: string;
  readonly labelKey: string;
  readonly only?: string;
}[] = [
  { value: "<7d", labelKey: "search.suggest.dates.last7d" },
  { value: "<30d", labelKey: "search.suggest.dates.last30d" },
  { value: ">30d", labelKey: "search.suggest.dates.over30d" },
  { value: ">90d", labelKey: "search.suggest.dates.over90d" },
  { value: "year", labelKey: "search.suggest.dates.thisYear" },
  {
    value: "never",
    labelKey: "search.suggest.dates.never",
    only: "launched",
  },
];

/**
 * A value as the grammar needs it written: quoted when it holds a space, a
 * comma, a leading comparison, or would otherwise read as `none` or `any`.
 * `null` for a value the grammar cannot hold (it has a double quote).
 */
export function quoteProfileSearchValue(
  value: string,
  forceQuotes = false,
): string | null {
  if (value.includes(QUOTE)) return null;
  const needs =
    forceQuotes ||
    value.length === 0 ||
    /[\s,]/.test(value) ||
    /^[=<>]/.test(value) ||
    RESERVED.has(value.toLowerCase()) ||
    value.toLowerCase() === "never";
  return needs ? `${QUOTE}${value}${QUOTE}` : value;
}

function ghostFor(
  query: string,
  caret: number,
  start: number,
  end: number,
  text: string,
): string {
  if (caret !== query.length || end !== query.length || start > caret) {
    return "";
  }
  const typed = query.slice(start, caret).toLowerCase();
  const shown = text.trimEnd();
  if (shown.toLowerCase().startsWith(typed)) return shown.slice(typed.length);
  if (shown.startsWith(QUOTE) && !typed.startsWith(QUOTE)) {
    const inner = shown.slice(1, shown.endsWith(QUOTE) ? -1 : undefined);
    if (inner.toLowerCase().startsWith(typed)) return inner.slice(typed.length);
  }
  return "";
}

export function applyProfileSearchSuggestion(
  query: string,
  suggestion: Pick<
    ProfileSearchSuggestion,
    "start" | "end" | "text" | "caretOffset"
  >,
): { query: string; caret: number } {
  return {
    query:
      query.slice(0, suggestion.start) +
      suggestion.text +
      query.slice(suggestion.end),
    caret: suggestion.start + suggestion.caretOffset,
  };
}

type Draft = Omit<ProfileSearchSuggestion, "ghost" | "query" | "caretOffset"> &
  Partial<Pick<ProfileSearchSuggestion, "caretOffset">>;

/** What fits at the caret, best first. */
export function suggestProfileSearch(
  query: string,
  caret: number,
  vocabulary: ProfileSearchVocabulary,
  options: ProfileSearchSuggestOptions = {},
): ProfileSearchSuggestions {
  const { raw, tokens } = analyze(query);
  const make = (draft: Draft, ghost = true): ProfileSearchSuggestion => {
    const caretOffset = draft.caretOffset ?? draft.text.length;
    return {
      ...draft,
      caretOffset,
      ghost: ghost
        ? ghostFor(query, caret, draft.start, draft.end, draft.text)
        : "",
      query: applyProfileSearchSuggestion(query, { ...draft, caretOffset })
        .query,
    };
  };
  const index = tokens.findIndex((t) => t.start < caret && caret <= t.end);

  if (index < 0) {
    if (query.trim().length === 0) {
      const whole = { start: 0, end: query.length, completes: true };
      return {
        items: [
          ...(options.recent ?? []).map((recent) =>
            make(
              {
                ...whole,
                id: `recent:${recent}`,
                kind: "recent",
                label: recent,
                text: recent,
              },
              false,
            ),
          ),
          ...PROFILE_SEARCH_EXAMPLES.map((example) =>
            make(
              {
                ...whole,
                id: `example:${example.labelKey}`,
                kind: "example",
                label: example.query,
                descriptionKey: example.labelKey,
                text: example.query,
              },
              false,
            ),
          ),
        ],
      };
    }
    const next = query[caret];
    const pad = next !== undefined && !/\s/.test(next) ? " " : "";
    const before = tokens.filter((t) => t.end <= caret);
    const previous = before[before.length - 1];
    const items: ProfileSearchSuggestion[] = [];
    if (previous && !previous.keyword) {
      items.push(
        make(
          {
            id: "operator:or",
            kind: "operator",
            label: "or",
            descriptionKey: "search.operators.or",
            start: caret,
            end: caret,
            text: `or${pad || (next === undefined ? " " : "")}`,
            caretOffset: 3,
            completes: false,
          },
          false,
        ),
      );
    }
    items.push(
      make(
        {
          id: "operator:not",
          kind: "operator",
          label: "-",
          descriptionKey: "search.operators.negate",
          start: caret,
          end: caret,
          text: "-",
          completes: false,
        },
        false,
      ),
    );
    for (const field of PROFILE_SEARCH_FIELDS) {
      items.push(
        make(
          {
            id: `field:${field.key}`,
            kind: "field",
            label: `${field.key}:`,
            field: field.key,
            descriptionKey: field.labelKey,
            start: caret,
            end: caret,
            text: `${field.key}:${pad}`,
            caretOffset: field.key.length + 1,
            completes: false,
          },
          false,
        ),
      );
    }
    return { items };
  }

  const active = tokens[index];
  const prefixRaw: RawToken = {
    start: active.start,
    end: caret,
    chars: raw[index].chars.filter((ch) => ch.at < caret),
  };
  const prefix = readToken(prefixRaw, null);
  const issue = active.issue;

  if (prefix.field && prefix.valueStart !== undefined) {
    return {
      items: valueSuggestions(query, caret, active, prefix, vocabulary, {
        make,
        now: options.now ?? Date.now(),
      }),
      issue,
    };
  }

  if (issue?.code === "unknownField" && active.name) {
    const field = findProfileSearchField(issue.field);
    return {
      items: field
        ? [
            make(
              {
                id: `field:${field.key}`,
                kind: "field",
                label: `${field.key}:`,
                field: field.key,
                descriptionKey: field.labelKey,
                start: active.name.start,
                end: active.name.end,
                text: field.key,
                caretOffset:
                  field.key.length + (query[active.name.end] === ":" ? 1 : 0),
                completes: false,
              },
              false,
            ),
          ]
        : [],
      issue,
    };
  }

  if (prefix.separated || query.slice(active.start, caret).includes(QUOTE)) {
    return { items: [], issue };
  }

  let nameStart = active.start;
  const lead = query[nameStart];
  if (lead === "-" || lead === "!") nameStart++;
  const typed = query.slice(nameStart, caret).toLowerCase();
  const hasSeparator = active.separated && active.name !== undefined;
  const items: ProfileSearchSuggestion[] = [];

  const keyHits = PROFILE_SEARCH_FIELDS.filter((f) => f.key.startsWith(typed));
  const aliasHits = PROFILE_SEARCH_FIELDS.filter(
    (f) =>
      !keyHits.includes(f) &&
      f.aliases.some((alias) => alias.startsWith(typed)),
  );
  for (const field of [...keyHits, ...aliasHits]) {
    items.push(
      make(
        {
          id: `field:${field.key}`,
          kind: "field",
          label: `${field.key}:`,
          field: field.key,
          descriptionKey: field.labelKey,
          start: nameStart,
          end: hasSeparator && active.name ? active.name.end : caret,
          text: hasSeparator ? field.key : `${field.key}:`,
          completes: false,
        },
        typed.length > 0,
      ),
    );
  }

  if (typed.length >= MIN_MATCH_LENGTH && !active.separated) {
    const hits: {
      field: string;
      entry: ProfileSearchVocabularyEntry;
      prefix: boolean;
    }[] = [];
    for (const key of MATCH_FIELDS) {
      for (const entry of vocabulary.get(key) ?? []) {
        const lower = entry.value.toLowerCase();
        const at = lower.indexOf(typed);
        if (at >= 0) hits.push({ field: key, entry, prefix: at === 0 });
      }
    }
    hits.sort(
      (a, b) =>
        Number(b.prefix) - Number(a.prefix) || b.entry.count - a.entry.count,
    );
    const atEnd = active.end === query.length;
    for (const hit of hits) {
      if (items.length >= keyHits.length + aliasHits.length + MATCH_LIMIT) {
        break;
      }
      const value = quoteProfileSearchValue(hit.entry.value);
      if (value === null) continue;
      const text = `${hit.field}:${value}${atEnd ? " " : ""}`;
      items.push(
        make(
          {
            id: `match:${hit.field}:${hit.entry.value}`,
            kind: "match",
            label: hit.entry.value,
            field: hit.field,
            start: nameStart,
            end: active.end,
            text,
            completes: true,
          },
          false,
        ),
      );
    }
  }

  return { items, issue };
}

function valueSuggestions(
  query: string,
  caret: number,
  active: ProfileSearchToken,
  prefix: ProfileSearchToken,
  vocabulary: ProfileSearchVocabulary,
  helpers: {
    make: (draft: Draft, ghost?: boolean) => ProfileSearchSuggestion;
    now: number;
  },
): ProfileSearchSuggestion[] {
  const { make } = helpers;
  const field = prefix.field as ProfileSearchField;
  const valueStart = prefix.valueStart as number;
  const lastPiece = prefix.pieces[prefix.pieces.length - 1];
  const afterComma = !prefix.quoted && query[caret - 1] === ",";
  const pieceStart =
    afterComma || !lastPiece || lastPiece.end < caret
      ? afterComma
        ? caret
        : valueStart
      : lastPiece.start;
  const fullPiece = active.pieces.find(
    (p) => p.start <= caret && caret <= p.end,
  );
  const pieceEnd = fullPiece ? Math.max(fullPiece.end, caret) : caret;
  const firstPiece = pieceStart === valueStart;
  const typedRaw = query.slice(pieceStart, caret);
  const openQuote = typedRaw.startsWith(QUOTE);
  const typed = typedRaw.replaceAll(QUOTE, "").toLowerCase();
  const atEnd = pieceEnd === query.length;
  const trail = atEnd ? " " : "";
  const items: ProfileSearchSuggestion[] = [];

  if (field.kind === "date") {
    const start = prefix.afterSeparator as number;
    // `created>=` already holds the comparison the templates would add.
    if (query[start - 1] !== ":") return items;
    const typedDate = query.slice(start, caret).toLowerCase();
    const year = String(new Date(helpers.now).getFullYear());
    for (const template of DATE_TEMPLATES) {
      if (template.only && template.only !== field.key) continue;
      const value = template.value === "year" ? year : template.value;
      if (!value.startsWith(typedDate)) continue;
      items.push(
        make({
          id: `value:${field.key}:${value}`,
          kind: "value",
          label: value,
          field: field.key,
          descriptionKey: template.labelKey,
          start,
          end: Math.max(active.end, caret),
          text: `${value}${active.end === query.length ? " " : ""}`,
          completes: true,
        }),
      );
    }
    return items;
  }

  const candidates: { value: string; descriptionKey?: string }[] = [];
  if (field.kind === "boolean" || field.kind === "enum") {
    for (const value of field.values ?? []) {
      if (value.startsWith(typed)) candidates.push({ value });
    }
  } else {
    const entries = vocabulary.get(field.key) ?? [];
    const starts: ProfileSearchVocabularyEntry[] = [];
    const contains: ProfileSearchVocabularyEntry[] = [];
    for (const entry of entries) {
      const at = entry.value.toLowerCase().indexOf(typed);
      if (at === 0) starts.push(entry);
      else if (at > 0) contains.push(entry);
    }
    const ranked = [
      ...starts.filter((e) => e.count > 0),
      ...contains.filter((e) => e.count > 0),
      ...starts.filter((e) => e.count === 0),
      ...contains.filter((e) => e.count === 0),
    ];
    for (const entry of ranked) candidates.push({ value: entry.value });
  }

  for (const candidate of candidates) {
    if (items.length >= PROFILE_SEARCH_VALUE_LIMIT) break;
    const written = quoteProfileSearchValue(candidate.value, openQuote);
    if (written === null) continue;
    if (!firstPiece && written.startsWith(QUOTE)) continue;
    items.push(
      make({
        id: `value:${field.key}:${candidate.value}`,
        kind: "value",
        label: candidate.value,
        field: field.key,
        start: pieceStart,
        end: pieceEnd,
        text: `${written}${trail}`,
        completes: true,
      }),
    );
  }

  if (
    NONE_ANY_FIELDS.has(field.key) &&
    firstPiece &&
    !prefix.exact &&
    !openQuote
  ) {
    for (const reserved of ["none", "any"]) {
      if (!reserved.startsWith(typed)) continue;
      items.push(
        make({
          id: `reserved:${field.key}:${reserved}`,
          kind: "value",
          label: reserved,
          field: field.key,
          descriptionKey: `search.suggest.${reserved}`,
          start: pieceStart,
          end: pieceEnd,
          text: `${reserved}${trail}`,
          completes: true,
        }),
      );
    }
  }
  return items;
}

/** Profiles a query matches; every profile for one with nothing to filter on. */
export function countProfileSearchMatches(
  profiles: readonly BrowserProfile[],
  query: string,
  ctx: ProfileSearchContext,
): number {
  const parsed = parseProfileSearch(query);
  if (parsed.isEmpty) return profiles.length;
  let count = 0;
  for (const profile of profiles) {
    if (matchesProfile(profile, parsed, ctx)) count++;
  }
  return count;
}

/**
 * Puts `text` in as a term of its own: after the token the caret is in, with
 * the spaces it needs on either side. For the help panel's field and operator
 * rows, which may be clicked with the caret anywhere.
 */
export function insertProfileSearchTerm(
  query: string,
  caret: number,
  text: string,
): { query: string; caret: number } {
  const token = analyze(query).tokens.find(
    (t) => t.start < caret && caret <= t.end,
  );
  const at = token ? token.end : caret;
  const before = at > 0 && !/\s/.test(query[at - 1]) ? " " : "";
  const after = at < query.length && !/\s/.test(query[at]) ? " " : "";
  return {
    query: query.slice(0, at) + before + text + after + query.slice(at),
    caret: at + before.length + text.length,
  };
}

export const RECENT_PROFILE_SEARCH_LIMIT = 8;

/** Adds a query to the front of the recent list, once, keeping the newest few. */
export function rememberProfileSearch(
  recent: readonly string[],
  query: string,
  limit = RECENT_PROFILE_SEARCH_LIMIT,
): string[] {
  const trimmed = query.trim();
  if (trimmed.length < 2 || parseProfileSearch(trimmed).isEmpty) {
    return [...recent];
  }
  const key = trimmed.toLowerCase();
  return [
    trimmed,
    ...recent.filter((entry) => entry.toLowerCase() !== key),
  ].slice(0, limit);
}
