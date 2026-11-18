/**
 * Ready-made agent tasks for work across profiles. The copy lives under
 * `agent.templates.items.<id>` in every locale: `title`, `description` and
 * `prompt`. A "[word]" in a prompt is a blank the composer selects first.
 *
 * Kept free of runtime imports so `agent-templates.test.mjs` can load it
 * directly; the icons are in `components/agent-chat/templates.tsx`.
 */

export const TEMPLATE_CATEGORIES = [
  "accounts",
  "social",
  "sellers",
  "ads",
  "research",
  "monitoring",
  "health",
] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** One profile, or the same task in each profile of a group. */
export type TemplateScope = "one" | "each";

interface TemplateDefinition {
  id: string;
  category: TemplateCategory;
  scope: TemplateScope;
  /** A cron the repeat picker starts from, in the local time zone. */
  schedule?: string;
  /** The task posts, sends, pays, deletes or changes settings; the prompt asks first. */
  asksFirst?: boolean;
  /** Shown on the new-chat page. */
  featured?: boolean;
}

const DAILY_9 = "0 9 * * *";
const WEEKDAYS_9 = "0 9 * * 1-5";
const MONDAY_9 = "0 9 * * 1";

const CATALOG = [
  {
    id: "accountStatus",
    category: "accounts",
    scope: "each",
    schedule: DAILY_9,
    featured: true,
  },
  {
    id: "warmUp",
    category: "accounts",
    scope: "each",
    schedule: "0 11 * * *",
    featured: true,
  },
  {
    id: "sessionCheck",
    category: "accounts",
    scope: "each",
    asksFirst: true,
  },
  {
    id: "passwordAge",
    category: "accounts",
    scope: "each",
    schedule: MONDAY_9,
    asksFirst: true,
  },
  {
    id: "platformNotices",
    category: "accounts",
    scope: "each",
    schedule: DAILY_9,
  },
  {
    id: "postAcross",
    category: "social",
    scope: "each",
    asksFirst: true,
  },
  {
    id: "dailyPost",
    category: "social",
    scope: "each",
    schedule: "0 10 * * *",
    asksFirst: true,
  },
  {
    id: "replyComments",
    category: "social",
    scope: "each",
    asksFirst: true,
  },
  {
    id: "inboxDigest",
    category: "social",
    scope: "each",
    schedule: DAILY_9,
  },
  {
    id: "followerStats",
    category: "social",
    scope: "each",
    schedule: MONDAY_9,
  },
  {
    id: "newOrders",
    category: "sellers",
    scope: "each",
    schedule: "0 8 * * *",
    featured: true,
  },
  {
    id: "listingHealth",
    category: "sellers",
    scope: "each",
    schedule: WEEKDAYS_9,
  },
  {
    id: "reviewReplies",
    category: "sellers",
    scope: "each",
    asksFirst: true,
  },
  {
    id: "buyerMessages",
    category: "sellers",
    scope: "each",
    asksFirst: true,
  },
  {
    id: "listingPrice",
    category: "sellers",
    scope: "each",
    schedule: DAILY_9,
  },
  {
    id: "adsByCountry",
    category: "ads",
    scope: "each",
  },
  {
    id: "landingByCountry",
    category: "ads",
    scope: "each",
  },
  {
    id: "offerLinks",
    category: "ads",
    scope: "one",
    schedule: DAILY_9,
  },
  {
    id: "competitorAds",
    category: "ads",
    scope: "one",
    schedule: MONDAY_9,
  },
  {
    id: "adSpend",
    category: "ads",
    scope: "each",
    schedule: DAILY_9,
  },
  {
    id: "pageToTable",
    category: "research",
    scope: "one",
  },
  {
    id: "serpByCountry",
    category: "research",
    scope: "each",
  },
  {
    id: "pricesByCountry",
    category: "research",
    scope: "each",
  },
  {
    id: "enrichList",
    category: "research",
    scope: "one",
  },
  {
    id: "reviewSummary",
    category: "research",
    scope: "one",
  },
  {
    id: "priceDrop",
    category: "monitoring",
    scope: "one",
    schedule: DAILY_9,
  },
  {
    id: "pageWatch",
    category: "monitoring",
    scope: "one",
    schedule: DAILY_9,
  },
  {
    id: "backInStock",
    category: "monitoring",
    scope: "one",
    schedule: "0 * * * *",
  },
  {
    id: "rankByCountry",
    category: "monitoring",
    scope: "each",
    schedule: MONDAY_9,
  },
  {
    id: "accountLimits",
    category: "monitoring",
    scope: "each",
    schedule: DAILY_9,
  },
  {
    id: "proxyMatch",
    category: "health",
    scope: "each",
    featured: true,
  },
  {
    id: "stillSignedIn",
    category: "health",
    scope: "each",
    schedule: DAILY_9,
  },
  {
    id: "blockedPages",
    category: "health",
    scope: "each",
  },
  {
    id: "leakCheck",
    category: "health",
    scope: "each",
  },
] as const satisfies readonly TemplateDefinition[];

export type AgentTemplateId = (typeof CATALOG)[number]["id"];

export interface AgentTemplate extends TemplateDefinition {
  id: AgentTemplateId;
}

/** Every template, in the order the gallery lists them. */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = CATALOG;

/** The blanks of a template prompt ("[site]", "[topic]"), each once. */
export function templateBlanks(prompt: string): string[] {
  return [...new Set(prompt.match(/\[[^\]\n]+\]/g) ?? [])];
}

/**
 * Where the next of `blanks` is in `text`, at or after `from`, else the first
 * one before it; null when none is left.
 */
export function nextBlank(
  text: string,
  blanks: readonly string[],
  from = 0,
): { start: number; end: number } | null {
  let after: { start: number; end: number } | null = null;
  let before: { start: number; end: number } | null = null;
  for (const blank of blanks) {
    for (
      let at = text.indexOf(blank);
      at >= 0;
      at = text.indexOf(blank, at + 1)
    ) {
      const hit = { start: at, end: at + blank.length };
      if (at >= from) {
        if (!after || at < after.start) after = hit;
      } else if (!before || at < before.start) {
        before = hit;
      }
    }
  }
  return after ?? before;
}
