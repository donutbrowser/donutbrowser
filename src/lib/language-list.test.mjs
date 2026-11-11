import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatLanguageList, parseLanguageList } from "./language-list.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORM = path.join(HERE, "..", "components", "wayfern-config-form.tsx");
const source = readFileSync(FORM, "utf8");

test("a JSON array and a comma list read as the same tags", () => {
  const expected = ["en-US", "uk-UA", "uk", "ru"];
  assert.deepEqual(parseLanguageList('["en-US","uk-UA","uk","ru"]'), expected);
  assert.deepEqual(parseLanguageList("en-US, uk-UA, uk, ru"), expected);
  assert.deepEqual(parseLanguageList("en-US uk-UA\nuk,ru"), expected);
});

test("every intermediate text of deleting tags one key at a time is a list", () => {
  // Deleting `,"uk-UA","uk","ru"` from the end, one key at a time: no text on
  // the way may be unreadable, or the field would refuse the edit.
  const shown = '["en-US","uk-UA","uk","ru"]';
  const target = '["en-US"]';
  const kept = '["en-US"';
  let text = shown;
  while (text.length > kept.length) {
    text = text.slice(0, -1);
    const parsed = parseLanguageList(text);
    if (parsed !== null) {
      assert.ok(parsed.length >= 1 && parsed[0] === "en-US", text);
    }
  }
  assert.deepEqual(parseLanguageList(`${text}]`), ["en-US"]);
  assert.deepEqual(parseLanguageList(target), ["en-US"]);
});

test("an incomplete tag is not committed", () => {
  assert.equal(parseLanguageList('["en-US","r'), null);
  assert.equal(parseLanguageList("en-US, de-"), null);
  assert.equal(parseLanguageList("en_US"), null);
});

test("empty text is the empty list", () => {
  assert.deepEqual(parseLanguageList(""), []);
  assert.deepEqual(parseLanguageList("[]"), []);
});

test("the stored list is shown as JSON, an old string as it is", () => {
  assert.equal(formatLanguageList(["en-US", "en"]), '["en-US","en"]');
  assert.equal(formatLanguageList("de-DE,de"), "de-DE,de");
  assert.equal(formatLanguageList(undefined), "");
  assert.deepEqual(parseLanguageList(formatLanguageList(["en-US", "en"])), [
    "en-US",
    "en",
  ]);
});

test("the form keeps what the person types until the field loses focus", () => {
  const field = source.slice(
    source.indexOf('id="languages"'),
    source.indexOf("</div>", source.indexOf('id="languages"')),
  );
  // A field whose value is only the stored list throws away every keystroke
  // that does not parse, which is most keystrokes of any edit.
  assert.match(field, /value=\{\s*languagesDraft \?\?\s*formatLanguageList\(/);
  assert.match(field, /setLanguagesDraft\(e\.target\.value\)/);
  assert.match(field, /parseLanguageList\(e\.target\.value\)/);
  assert.match(field, /onBlur=\{\(\) => setLanguagesDraft\(null\)\}/);
  assert.doesNotMatch(field, /JSON\.parse/);
});
