import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cronWords, MAX_PROMPT_CHARS } from "./agent-tasks.ts";
import {
  AGENT_TEMPLATES,
  firstBlank,
  TEMPLATE_CATEGORIES,
} from "./agent-templates.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = path.join(HERE, "..", "i18n", "locales");

function locales() {
  return readdirSync(LOCALES)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      name: file,
      templates: JSON.parse(readFileSync(path.join(LOCALES, file), "utf8"))
        .agent.templates,
    }));
}

const blanks = (text) => text.match(/\[[^\]]+\]/g) ?? [];

test("template ids are unique and every category has templates", () => {
  const ids = AGENT_TEMPLATES.map((template) => template.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const category of TEMPLATE_CATEGORIES) {
    const count = AGENT_TEMPLATES.filter(
      (template) => template.category === category,
    ).length;
    assert.ok(count >= 4, `${category} has ${count} templates`);
  }
  assert.equal(
    AGENT_TEMPLATES.filter((template) => template.featured).length,
    4,
    "the new-chat page shows four",
  );
});

test("every locale has the copy of every template and category", () => {
  for (const { name, templates } of locales()) {
    assert.ok(templates, `${name} has agent.templates`);
    for (const category of TEMPLATE_CATEGORIES) {
      assert.ok(templates.categories[category], `${name} ${category}`);
    }
    for (const template of AGENT_TEMPLATES) {
      const copy = templates.items[template.id];
      for (const field of ["title", "description", "prompt"]) {
        assert.ok(copy?.[field]?.trim(), `${name} ${template.id}.${field}`);
      }
      assert.ok(copy.prompt.length <= MAX_PROMPT_CHARS);
    }
    assert.deepEqual(
      Object.keys(templates.items).sort(),
      AGENT_TEMPLATES.map((template) => template.id).sort(),
      `${name} has no copy of removed templates`,
    );
  }
});

test("a prompt keeps its blanks in every locale", () => {
  const en = locales().find(({ name }) => name === "en.json").templates;
  for (const { name, templates } of locales()) {
    for (const template of AGENT_TEMPLATES) {
      assert.equal(
        blanks(templates.items[template.id].prompt).length,
        blanks(en.items[template.id].prompt).length,
        `${name} ${template.id}`,
      );
    }
  }
});

test("a template that posts, sends or changes settings asks first", () => {
  const en = locales().find(({ name }) => name === "en.json").templates;
  for (const template of AGENT_TEMPLATES) {
    const prompt = en.items[template.id].prompt;
    assert.equal(
      /\bask me before\b/i.test(prompt),
      template.asksFirst === true,
      template.id,
    );
  }
});

test("a suggested schedule reads as words", () => {
  for (const template of AGENT_TEMPLATES) {
    if (!template.schedule) continue;
    assert.notEqual(cronWords(template.schedule).kind, "custom", template.id);
  }
});

test("firstBlank selects the first [word]", () => {
  assert.deepEqual(firstBlank("Open [site] and [page]"), { start: 5, end: 11 });
  assert.equal(firstBlank("No blank here"), null);
  assert.equal(firstBlank("Open ] then ["), null);
});
