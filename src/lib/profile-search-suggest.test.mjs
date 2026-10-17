import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// The suggest module imports `./profile-search` the way the bundler resolves
// it, without an extension; node needs the `.ts` spelled out.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  analyzeProfileSearch,
  applyProfileSearchSuggestion,
  buildProfileSearchVocabulary,
  countProfileSearchMatches,
  insertProfileSearchTerm,
  quoteProfileSearchValue,
  rememberProfileSearch,
  RECENT_PROFILE_SEARCH_LIMIT,
  suggestProfileSearch,
} = await import("./profile-search-suggest.ts");
const { PROFILE_SEARCH_EXAMPLES } = await import("./profile-search.ts");

const NOW = Date.parse("2026-06-15T12:00:00Z");

const ctx = {
  groupNames: new Map([
    ["g1", "Client A"],
    ["g2", "Clients archive"],
    ["g3", "Empty group"],
  ]),
  proxyNames: new Map([["p1", "Frankfurt residential"]]),
  vpnNames: new Map([["v1", "Office WireGuard"]]),
  extensionGroupNames: new Map([["e1", "Ad blockers"]]),
  statusNames: new Map([["s1", "Warming up"]]),
  runningProfiles: new Set(["a"]),
  now: NOW,
};

function profile(id, overrides = {}) {
  return {
    id,
    name: `Profile ${id}`,
    browser: "wayfern",
    version: "140.0.3",
    release_type: "stable",
    ...overrides,
  };
}

const profiles = [
  profile("a", { group_id: "g1", tags: ["shopping", "eu"], proxy_id: "p1" }),
  profile("b", { group_id: "g1", tags: ["shopping"] }),
  profile("c", { group_id: "g2", tags: ["seo"], version: "139.0.1" }),
];

const vocabulary = buildProfileSearchVocabulary(profiles, ctx);

function suggest(query, caret = query.length, options = {}) {
  return suggestProfileSearch(query, caret, vocabulary, {
    now: NOW,
    ...options,
  });
}

function labels(query, caret) {
  return suggest(query, caret).items.map((item) => item.label);
}

function accept(query, item) {
  return applyProfileSearchSuggestion(query, item);
}

function kindsOf(query) {
  return analyzeProfileSearch(query).spans.map(
    (span) => `${query.slice(span.start, span.end)}=${span.kind}`,
  );
}

test("the vocabulary counts real values and keeps unused names last", () => {
  assert.deepEqual(vocabulary.get("group"), [
    { value: "Client A", count: 2 },
    { value: "Clients archive", count: 1 },
    { value: "Empty group", count: 0 },
  ]);
  assert.deepEqual(
    vocabulary.get("tag").map((entry) => entry.value),
    ["shopping", "eu", "seo"],
  );
  assert.deepEqual(
    vocabulary.get("version").map((entry) => entry.value),
    ["140.0.3", "139.0.1"],
  );
});

test("a field name completes as ghost text, with its colon", () => {
  const [first] = suggest("gr").items;
  assert.equal(first.label, "group:");
  assert.equal(first.ghost, "oup:");
  const next = accept("gr", first);
  assert.deepEqual(next, { query: "group:", caret: 6 });
  assert.equal(first.completes, false);
});

test("aliases find their field, and negation is kept", () => {
  assert.deepEqual(labels("fold"), ["group:"]);
  const [first] = suggest("-ta").items;
  assert.equal(first.label, "tag:");
  assert.equal(first.ghost, "g:");
  assert.equal(accept("-ta", first).query, "-tag:");
});

test("values come from the user's data, quoted when they hold a space", () => {
  const { items } = suggest("group:cl");
  assert.deepEqual(
    items.map((item) => item.label),
    ["Client A", "Clients archive"],
  );
  assert.equal(items[0].ghost, "ient A");
  assert.equal(items[0].text, '"Client A" ');
  assert.equal(items[0].completes, true);
  assert.deepEqual(accept("group:cl", items[0]), {
    query: 'group:"Client A" ',
    caret: 17,
  });
});

test("an empty value offers every value, then none and any", () => {
  const items = suggest("group:").items;
  assert.deepEqual(
    items.map((item) => item.label),
    ["Client A", "Clients archive", "Empty group", "none", "any"],
  );
  assert.equal(items[0].ghost, '"Client A"');
  assert.equal(items[3].descriptionKey, "search.suggest.none");
});

test("an open quote continues inside the quotes", () => {
  const [first] = suggest('group:"cl').items;
  assert.equal(first.text, '"Client A" ');
  assert.equal(first.ghost, 'ient A"');
});

test("enum and boolean fields offer their own slugs", () => {
  assert.deepEqual(labels("os:"), ["macos", "windows", "linux", "none", "any"]);
  assert.deepEqual(labels("status:r"), ["running"]);
  assert.deepEqual(labels("locked:"), ["yes", "no"]);
  assert.deepEqual(labels("dns:pro"), ["pro", "pro_plus"]);
});

test("the comma shorthand completes the piece under the caret", () => {
  const items = suggest("tag:eu,sh").items;
  assert.equal(items[0].label, "shopping");
  assert.deepEqual(accept("tag:eu,sh", items[0]), {
    query: "tag:eu,shopping ",
    caret: 16,
  });
  assert.deepEqual(labels("tag:eu,").slice(0, 3), ["shopping", "eu", "seo"]);
});

test("date fields offer spans and the current year", () => {
  assert.deepEqual(labels("launched:"), [
    "<7d",
    "<30d",
    ">30d",
    ">90d",
    "2026",
    "never",
  ]);
  assert.deepEqual(labels("created:>"), [">30d", ">90d"]);
  assert.deepEqual(labels("created>="), []);
  const item = suggest("launched:>").items[0];
  assert.equal(accept("launched:>", item).query, "launched:>30d ");
});

test("a bare word offers field matches from the data", () => {
  const items = suggest("shop").items;
  assert.equal(items[0].kind, "match");
  assert.equal(items[0].text, "tag:shopping ");
  assert.equal(items[0].ghost, "");
  const word = suggest("-clie").items.filter((item) => item.kind === "match");
  assert.deepEqual(
    word.map((item) => accept("-clie", item).query),
    ['-group:"Client A" ', '-group:"Clients archive" '],
  );
});

test("between terms the list offers operators and every field", () => {
  const items = suggest("tag:seo ").items;
  assert.equal(items[0].label, "or");
  assert.equal(accept("tag:seo ", items[0]).query, "tag:seo or ");
  assert.equal(items[1].label, "-");
  assert.ok(items.some((item) => item.label === "launched:"));
  assert.ok(items.every((item) => item.ghost === ""));
  assert.equal(
    suggest("tag:seo or ").items.some((item) => item.label === "or"),
    false,
  );
});

test("an empty box offers recent searches, then examples", () => {
  const items = suggest("", 0, { recent: ["tag:seo"] }).items;
  assert.equal(items[0].kind, "recent");
  assert.equal(items[0].query, "tag:seo");
  assert.deepEqual(
    items.slice(1).map((item) => item.label),
    PROFILE_SEARCH_EXAMPLES.map((example) => example.query),
  );
});

test("ghost text only shows at the end of the box", () => {
  const items = suggest("gr tag:seo", 2).items;
  assert.equal(items[0].label, "group:");
  assert.equal(items[0].ghost, "");
  assert.equal(accept("gr tag:seo", items[0]).query, "group: tag:seo");
});

test("a mistyped field is flagged and offers the fix", () => {
  const result = suggest("gro:x");
  assert.deepEqual(result.issue, {
    code: "unknownField",
    name: "gro",
    field: "group",
  });
  assert.deepEqual(accept("gro:x", result.items[0]), {
    query: "group:x",
    caret: 6,
  });
  assert.equal(suggest("vpm:office").issue?.field, "vpn");
  // A URL or a time of day is free text, not a typo.
  assert.equal(suggest("https://x.com").issue, undefined);
  assert.equal(suggest("12:30").issue, undefined);
});

test("tokens the parser drops or reads as text carry the reason", () => {
  const issueOf = (query) =>
    analyzeProfileSearch(query).tokens.map((t) => t.issue?.code ?? null);
  assert.deepEqual(issueOf("created:yesterday tag:ads"), ["date", null]);
  assert.deepEqual(issueOf("locked:maybe"), ["boolean"]);
  assert.deepEqual(issueOf("os:solaris os:mac os:=mac os:none"), [
    "enum",
    null,
    "enum",
    null,
  ]);
  assert.deepEqual(issueOf("tag:>5 version:>=140 created:<7d"), [
    "compare",
    null,
    null,
  ]);
  assert.deepEqual(issueOf("group: os:"), [null, null]);
});

test("highlighting marks fields, operators, negation, quotes and reserved words", () => {
  assert.deepEqual(kindsOf('-group:"Client A" or tag:ads,seo'), [
    "-=negate",
    "group:=field",
    '"Client A"=quoted',
    " =space",
    "or=operator",
    " =space",
    "tag:=field",
    "ads=value",
    ",=operator",
    "seo=value",
  ]);
  assert.deepEqual(kindsOf("created:>=2026 proxy:none tag:=prod"), [
    "created:=field",
    ">==operator",
    "2026=value",
    " =space",
    "proxy:=field",
    "none=reserved",
    " =space",
    "tag:=field",
    "==operator",
    "prod=value",
  ]);
  assert.deepEqual(kindsOf("foo:bar 12:30"), [
    "foo:bar=text",
    " =space",
    "12:30=text",
  ]);
});

test("spans cover the whole query", () => {
  for (const query of ['a  "b c', 'tag:"x" -', "  ", 'x"y"z:w', "or or"]) {
    const { spans } = analyzeProfileSearch(query);
    let at = 0;
    for (const span of spans) {
      assert.equal(span.start, at);
      at = span.end;
    }
    assert.equal(at, query.length);
  }
});

test("values the grammar would misread are quoted", () => {
  assert.equal(quoteProfileSearchValue("seo"), "seo");
  assert.equal(quoteProfileSearchValue("Client A"), '"Client A"');
  assert.equal(quoteProfileSearchValue("a,b"), '"a,b"');
  assert.equal(quoteProfileSearchValue("none"), '"none"');
  assert.equal(quoteProfileSearchValue(">x"), '">x"');
  assert.equal(quoteProfileSearchValue('say "hi"'), null);
});

test("a value with a space is not offered after a comma", () => {
  assert.deepEqual(labels("group:x,cl"), []);
});

test("counts are the rows the finished query would show", () => {
  assert.equal(countProfileSearchMatches(profiles, "", ctx), 3);
  assert.equal(countProfileSearchMatches(profiles, 'group:"Client A"', ctx), 2);
  assert.equal(countProfileSearchMatches(profiles, "status:running", ctx), 1);
  const [first] = suggest("tag:").items;
  assert.equal(countProfileSearchMatches(profiles, first.query, ctx), 2);
});

test("a term goes in after the token the caret is in, with spaces", () => {
  assert.deepEqual(insertProfileSearchTerm("", 0, "tag:"), {
    query: "tag:",
    caret: 4,
  });
  assert.deepEqual(insertProfileSearchTerm("shop", 2, "tag:"), {
    query: "shop tag:",
    caret: 9,
  });
  assert.deepEqual(insertProfileSearchTerm("a b", 0, "os:"), {
    query: "os: a b",
    caret: 3,
  });
});

test("recent searches keep the newest few, once each", () => {
  let recent = [];
  for (const query of ["tag:a", " tag:b ", "TAG:A", "", "x", '""']) {
    recent = rememberProfileSearch(recent, query);
  }
  assert.deepEqual(recent, ["TAG:A", "tag:b"]);
  for (let i = 0; i < 20; i++) {
    recent = rememberProfileSearch(recent, `tag:n${i}`);
  }
  assert.equal(recent.length, RECENT_PROFILE_SEARCH_LIMIT);
  assert.equal(recent[0], "tag:n19");
});

test("suggesting never throws on a query being typed", () => {
  const queries = [
    "",
    "-",
    "!",
    '"',
    'group:"',
    "group:=",
    "tag:,",
    "created:>=",
    "a or",
    "or",
    ":",
    "-:",
    "tag:ads,,seo",
    'x"y',
  ];
  for (const query of queries) {
    for (let caret = 0; caret <= query.length; caret++) {
      const { items } = suggest(query, caret);
      for (const item of items) {
        assert.equal(typeof accept(query, item).query, "string");
      }
    }
  }
});

test("the lexer reads every token the way the parser does", async () => {
  const { parseProfileSearch } = await import("./profile-search.ts");
  const queries = [
    'status:running group:"Client A"',
    "tag:none proxy:any -tag:archived",
    "launched:>30d or created>=2026-01 version:<=140",
    "foo:bar 12:30 -x !y tag!=ads",
    'note:"a, b" tag:ads,seo os:=mac',
    'or tag:a or or tag:b "or"',
    "tag:>5 group: =x -",
  ];
  for (const query of queries) {
    const fromParser = parseProfileSearch(query)
      .groups.flat()
      .map((term) =>
        term.type === "field"
          ? `${term.negated ? "-" : ""}${term.field.key}`
          : `${term.negated ? "-" : ""}text`,
      );
    const fromLexer = analyzeProfileSearch(query)
      .tokens.filter((t) => !t.keyword && (!t.field || t.pieces.length > 0))
      .map((t) => `${t.negated ? "-" : ""}${t.field ? t.field.key : "text"}`);
    assert.deepEqual(fromLexer, fromParser, query);
  }
});

test("a value named like a reserved word keeps its own row", () => {
  const named = buildProfileSearchVocabulary(
    [profile("n", { tags: ["none", "any"] })],
    ctx,
  );
  const items = suggestProfileSearch("tag:", 4, named, { now: NOW }).items;
  assert.deepEqual(
    items.map((item) => item.text),
    ['"any" ', '"none" ', "none ", "any "],
  );
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
});
