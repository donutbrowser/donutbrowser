/** A BCP 47 tag as `navigator.languages` carries one: a 2-8 letter language
 * subtag, then optional subtags. */
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

/** The text the languages field shows for a stored list. Old profiles store a
 * comma-separated string, which is shown as it is. */
export function formatLanguageList(languages: unknown): string {
  if (Array.isArray(languages)) return JSON.stringify(languages);
  return typeof languages === "string" ? languages : "";
}

/** The tags in what a person typed, or `null` while the text holds a tag that
 * is not complete. Commas, spaces, brackets and quotes all separate tags, so a
 * JSON array, `en-US, en` and a JSON array with one quote deleted all read as
 * the same list. Empty text is the empty list. */
export function parseLanguageList(text: string): string[] | null {
  const tags = text.split(/[\s,[\]"']+/).filter(Boolean);
  return tags.every((tag) => LANGUAGE_TAG.test(tag)) ? tags : null;
}
