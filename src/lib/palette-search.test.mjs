import assert from "node:assert/strict";
import test from "node:test";
import {
  matchRanges,
  paletteScore,
  parseRecents,
  RECENT_STORED,
  rememberRecent,
  searchTokens,
} from "./palette-search.ts";

test("an empty query matches everything", () => {
  assert.equal(paletteScore("Go to Settings", [], ""), 1);
  assert.equal(paletteScore("Go to Settings", [], "   "), 1);
});

test("every token must match, in any order", () => {
  assert.ok(paletteScore("Info — ctest", [], "ctest info") > 0);
  assert.equal(paletteScore("Go to Settings", [], "settings trash"), 0);
});

test("keywords find a command its label does not name", () => {
  assert.equal(paletteScore("Create profile", [], "new"), 0);
  assert.ok(paletteScore("Create profile", ["new add"], "new") > 0);
});

test("the label outranks keywords, and a word start outranks the middle", () => {
  const inLabel = paletteScore("Go to Settings", [], "set");
  const inKeyword = paletteScore("Go to Account", ["settings"], "set");
  const inMiddle = paletteScore("Go to Assets", [], "set");
  assert.ok(inLabel > inKeyword);
  assert.ok(inLabel > inMiddle);
});

test("an earlier match ranks higher", () => {
  assert.ok(
    paletteScore("Proxy settings", [], "proxy") >
      paletteScore("Go to the proxy list", [], "proxy"),
  );
});

test("matching ignores case", () => {
  assert.ok(paletteScore("Go to Network", [], "NETWORK") > 0);
  assert.deepEqual(searchTokens(" Go  TO "), ["go", "to"]);
});

test("match ranges prefer word starts and merge overlaps", () => {
  assert.deepEqual(matchRanges("Go to Settings", "set"), [[6, 9]]);
  assert.deepEqual(matchRanges("reset settings", "set"), [[6, 9]]);
  assert.deepEqual(matchRanges("Go to Settings", "sett set"), [[6, 10]]);
  assert.deepEqual(matchRanges("Go to Settings", "to go"), [
    [0, 2],
    [3, 5],
  ]);
  assert.deepEqual(matchRanges("Go to Settings", "zzz"), []);
  assert.deepEqual(matchRanges("Go to Settings", ""), []);
});

test("recent commands go first, once, up to the limit", () => {
  assert.deepEqual(rememberRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
  assert.deepEqual(rememberRecent([], "a"), ["a"]);
  const many = Array.from({ length: RECENT_STORED + 3 }, (_, i) => `c${i}`);
  const next = rememberRecent(many, "new");
  assert.equal(next.length, RECENT_STORED);
  assert.equal(next[0], "new");
});

test("a stored list that is not a list of strings reads as empty", () => {
  assert.deepEqual(parseRecents(null), []);
  assert.deepEqual(parseRecents("not json"), []);
  assert.deepEqual(parseRecents('{"a":1}'), []);
  assert.deepEqual(parseRecents('["a", 2, "b"]'), ["a", "b"]);
});
