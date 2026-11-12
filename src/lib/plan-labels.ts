import type { TFunction } from "i18next";

/** Where the plans are compared and bought. */
export const PRICING_URL = "https://donutbrowser.com/pricing";
/** Where a paid account manages its subscription and billing. */
export const ACCOUNT_URL = "https://donutbrowser.com/account";

const PLANS = new Set(["free", "solo", "pro", "team", "enterprise"]);
const PERIODS: Record<string, string> = {
  month: "monthly",
  monthly: "monthly",
  year: "yearly",
  yearly: "yearly",
  annual: "yearly",
};
const STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "paused",
]);

/** A value the cloud added after this build, readable but untranslated. */
function readable(value: string): string {
  const words = value.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function planLabel(t: TFunction, plan: string): string {
  return PLANS.has(plan) ? t(`account.plans.${plan}`) : readable(plan);
}

export function periodLabel(t: TFunction, period: string): string {
  const key = PERIODS[period];
  return key ? t(`account.periods.${key}`) : readable(period);
}

export function subscriptionStatusLabel(t: TFunction, status: string): string {
  return STATUSES.has(status)
    ? t(`account.statuses.${status}`)
    : readable(status);
}
