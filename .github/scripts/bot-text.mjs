// Text a model wrote goes into a public comment only through these filters.
// The model reads untrusted issue and pull request text, so its answer is
// untrusted too: one line, bounded, no pings, no links off the project, and
// none of the things the bots must never say.

const ALLOWED_URL =
  /^https:\/\/(?:(?:www\.)?donutbrowser\.com|github\.com\/donutbrowser)(?:[/?#]|$)/iu;
const URL = /\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'`)\]]+/giu;

const GUESS =
  /\b(?:possible|likely|probable|root)\s+causes?\b|\b(?:probably|likely)\s+(?:caused|due)\b|\bcaused\s+by\b/iu;
const SOURCE_REFERENCE =
  /\bsrc(?:-tauri)?\/|\b[\w-]+\.(?:rs|tsx?|jsx?|mjs|toml)\b|\bline\s+\d+\b/iu;
const PRAISE =
  /\b(?:well[- ](?:documented|structured|written|thought)|thorough|detailed\s+report|clear\s+(?:report|reproduction|enhancement)|reasonable\s+request|great\s+(?:report|idea|suggestion|catch))\b/iu;
const INTERNALS =
  /\b(?:subscription|license|licence|entitlement|plan)\s+(?:check|checks|validation|verification|server|enforcement)\b/iu;
const SECRET_REQUEST =
  /\b(?:passwords?|tokens?|credentials?|api\s+keys?|e-?mail\s+address|cookies?\s+values?)\b/iu;

function oneLine(value, limit) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s+/u, "")
    .replace(/[*_]{2,}/gu, "")
    .replace(/(^|[^\w`])@(?=[\w-])/gu, "$1");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function hasForeignUrl(text) {
  return (text.match(URL) ?? []).some((url) => !ALLOWED_URL.test(url));
}

// A sentence for an issue comment, or "" when it must not be posted.
export function issueLine(value, { limit = 240, question = false } = {}) {
  const text = oneLine(value, limit);
  if (text.length < 8) return "";
  if (hasForeignUrl(text)) return "";
  if (GUESS.test(text) || SOURCE_REFERENCE.test(text)) return "";
  if (PRAISE.test(text) || INTERNALS.test(text)) return "";
  if (question && SECRET_REQUEST.test(text)) return "";
  return text;
}

// A review note for a pull request. Source references are the point there.
export function reviewLine(value, { limit = 300 } = {}) {
  const text = oneLine(value, limit);
  if (text.length < 8 || hasForeignUrl(text) || PRAISE.test(text)) return "";
  return text;
}

export function unique(lines) {
  const seen = new Set();
  return lines.filter((line) => {
    const key = line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
