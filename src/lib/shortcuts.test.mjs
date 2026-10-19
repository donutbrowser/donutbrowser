import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..");
const LOCALES = path.join(SRC, "i18n", "locales");

// shortcuts.ts imports through the "@/" alias; point it at src/.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const file = path.join(SRC, `${specifier.slice(2)}.ts`);
      return nextResolve(pathToFileURL(file).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { SHORTCUTS, matchesShortcut, shortcutKeys } = await import(
  "./shortcuts.ts"
);

function lookup(tree, key) {
  return key
    .split(".")
    .reduce((node, part) => (node == null ? undefined : node[part]), tree);
}

// Mod is Cmd where platform.ts sees a Mac, Ctrl elsewhere.
const { isMacOS } = await import("./platform.ts");
const MAC = isMacOS();

function keyEvent(key, mods = {}) {
  return {
    key,
    metaKey: MAC && Boolean(mods.mod),
    ctrlKey: !MAC && Boolean(mods.mod),
    shiftKey: Boolean(mods.shift),
    altKey: Boolean(mods.alt),
  };
}

test("no two shortcuts share a chord", () => {
  const seen = new Map();
  for (const s of SHORTCUTS) {
    const chord = [
      s.mod ? "mod" : "",
      s.shift ? "shift" : "",
      s.alt ? "alt" : "",
      s.key.toLowerCase(),
    ].join("+");
    assert.equal(seen.get(chord), undefined, `${s.id} reuses ${chord}`);
    seen.set(chord, s.id);
  }
});

test("Mod+N makes a new profile and Mod+Shift+N opens Network", () => {
  const byId = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s]));
  assert.ok(matchesShortcut(byId.newProfile, keyEvent("n", { mod: true })));
  assert.ok(
    !matchesShortcut(byId.goProxies, keyEvent("n", { mod: true })),
    "plain Mod+N must not open Network",
  );
  assert.ok(
    matchesShortcut(byId.goProxies, keyEvent("N", { mod: true, shift: true })),
  );
});

test("slash focuses search with or without Shift, never with Mod", () => {
  const focus = SHORTCUTS.find((s) => s.id === "focusSearch");
  assert.ok(matchesShortcut(focus, keyEvent("/")));
  assert.ok(matchesShortcut(focus, keyEvent("/", { shift: true })));
  assert.ok(!matchesShortcut(focus, keyEvent("/", { mod: true })));
});

test("Escape goes back, is drawn as the Escape key, and stays out of the palette", () => {
  const back = SHORTCUTS.find((s) => s.id === "goBack");
  assert.ok(matchesShortcut(back, keyEvent("Escape")));
  assert.ok(!matchesShortcut(back, keyEvent("Escape", { shift: true })));
  assert.equal(shortcutKeys(back).at(-1).name, "escape");
  assert.equal(back.palette, false);
});

test("every locale names every shortcut and gives it palette keywords", () => {
  const files = readdirSync(LOCALES).filter((file) => file.endsWith(".json"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const locale = JSON.parse(readFileSync(path.join(LOCALES, file), "utf8"));
    for (const s of SHORTCUTS) {
      const label = lookup(locale, s.labelKey);
      assert.equal(typeof label, "string", `${file}: ${s.labelKey}`);
      assert.ok(label.length > 0, `${file}: ${s.labelKey} is empty`);
      const keywords = lookup(locale, `commandPalette.keywords.${s.id}`);
      assert.equal(
        typeof keywords,
        "string",
        `${file}: commandPalette.keywords.${s.id}`,
      );
    }
  }
});
