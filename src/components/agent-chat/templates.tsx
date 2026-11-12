"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IconType } from "react-icons";
import {
  LuArrowRight,
  LuBellRing,
  LuCalendarClock,
  LuChartColumn,
  LuChartLine,
  LuClipboardList,
  LuCookie,
  LuEarth,
  LuFingerprint,
  LuFlame,
  LuGauge,
  LuGlobeLock,
  LuHand,
  LuInbox,
  LuKeyRound,
  LuLink,
  LuListPlus,
  LuMegaphone,
  LuMessageCircleReply,
  LuMessageSquareQuote,
  LuMessagesSquare,
  LuPackage,
  LuPackageCheck,
  LuRepeat,
  LuRoute,
  LuScanSearch,
  LuSearch,
  LuSend,
  LuShieldAlert,
  LuShieldCheck,
  LuStar,
  LuTable,
  LuTag,
  LuTextSearch,
  LuTrendingDown,
  LuUser,
  LuUserCheck,
  LuUsers,
  LuWallet,
} from "react-icons/lu";
import { SearchField, SidebarToggle } from "@/components/agent-shell";
import { PaneHeader, useScheduleWords } from "@/components/agent-tasks/parts";
import type { Repeat } from "@/components/agent-tasks/repeat-picker";
import { Button } from "@/components/ui/button";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { localTimezone } from "@/lib/agent-tasks";
import {
  AGENT_TEMPLATES,
  type AgentTemplate,
  type AgentTemplateId,
  TEMPLATE_CATEGORIES,
  type TemplateCategory,
} from "@/lib/agent-templates";
import { paletteScore } from "@/lib/palette-search";
import { cn } from "@/lib/utils";

const ICONS: Record<AgentTemplateId, IconType> = {
  accountStatus: LuUserCheck,
  warmUp: LuFlame,
  sessionCheck: LuShieldCheck,
  passwordAge: LuKeyRound,
  platformNotices: LuBellRing,
  postAcross: LuSend,
  dailyPost: LuCalendarClock,
  replyComments: LuMessageCircleReply,
  inboxDigest: LuInbox,
  followerStats: LuChartLine,
  newOrders: LuPackage,
  listingHealth: LuClipboardList,
  reviewReplies: LuStar,
  buyerMessages: LuMessagesSquare,
  listingPrice: LuTag,
  adsByCountry: LuMegaphone,
  landingByCountry: LuRoute,
  offerLinks: LuLink,
  competitorAds: LuScanSearch,
  adSpend: LuWallet,
  pageToTable: LuTable,
  serpByCountry: LuSearch,
  pricesByCountry: LuEarth,
  enrichList: LuListPlus,
  reviewSummary: LuMessageSquareQuote,
  priceDrop: LuTrendingDown,
  pageWatch: LuTextSearch,
  backInStock: LuPackageCheck,
  rankByCountry: LuChartColumn,
  accountLimits: LuGauge,
  proxyMatch: LuFingerprint,
  stillSignedIn: LuCookie,
  blockedPages: LuShieldAlert,
  leakCheck: LuGlobeLock,
};

const FEATURED = AGENT_TEMPLATES.filter((template) => template.featured);

/** The repeat a template presets: its schedule, when the plan has schedules. */
export function templateRepeat(
  template: AgentTemplate,
  canSchedule: boolean,
): Repeat {
  return template.schedule && canSchedule
    ? {
        kind: "schedule",
        schedule: { cron: template.schedule, timezone: localTimezone() },
      }
    : { kind: "once" };
}

function TemplateIcon({ id }: { id: AgentTemplateId }) {
  const Icon = ICONS[id];
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-foreground/5 text-muted-foreground">
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}

/** Ready-made tasks on the new-chat page, and the way to all of them. */
export function FeaturedTemplates({
  onPick,
  onShowAll,
}: {
  onPick: (template: AgentTemplate) => void;
  onShowAll: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <ul
        aria-label={t("agent.templates.title")}
        className="grid grid-cols-1 gap-1 @[34rem]:grid-cols-2"
      >
        {FEATURED.map((template) => (
          <li key={template.id}>
            <button
              type="button"
              data-slot="agent-template"
              data-template={template.id}
              onClick={() => {
                onPick(template);
              }}
              className={cn(
                "flex w-full cursor-pointer items-center gap-3 rounded-2xl p-2 text-left transition-colors duration-150 hover:bg-foreground/5 motion-reduce:transition-none",
                FOCUS_RING,
              )}
            >
              <TemplateIcon id={template.id} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm">
                  {t(`agent.templates.items.${template.id}.title`)}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {t(`agent.templates.items.${template.id}.description`)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="subtle"
        size="sm"
        data-slot="agent-templates-all"
        onClick={onShowAll}
        className="h-8 gap-1.5 self-center rounded-xl px-3 text-xs text-muted-foreground"
      >
        {t("agent.templates.all")}
        <span className="tabular-nums">{AGENT_TEMPLATES.length}</span>
        <LuArrowRight className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}

function TemplateCard({
  template,
  onPick,
}: {
  template: AgentTemplate;
  onPick: (template: AgentTemplate) => void;
}) {
  const { t } = useTranslation();
  const scheduleWords = useScheduleWords();
  const Icon = ICONS[template.id];
  const ScopeIcon = template.scope === "each" ? LuUsers : LuUser;
  return (
    <li>
      <button
        type="button"
        data-slot="agent-template"
        data-template={template.id}
        data-category={template.category}
        onClick={() => {
          onPick(template);
        }}
        className={cn(
          "relative flex h-full w-full cursor-pointer flex-col gap-2.5 rounded-2xl bg-foreground/5 p-3 text-left transition-colors duration-150 hover:bg-foreground/8 motion-reduce:transition-none",
          FOCUS_RING,
        )}
      >
        <span className="flex min-w-0 items-start gap-2.5">
          <Icon
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 pr-5">
            <span className="text-sm leading-5 font-medium">
              {t(`agent.templates.items.${template.id}.title`)}
            </span>
            <span className="line-clamp-2 text-xs leading-4 text-muted-foreground">
              {t(`agent.templates.items.${template.id}.description`)}
            </span>
          </span>
        </span>
        <span className="mt-auto flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <ScopeIcon className="size-3 shrink-0" aria-hidden="true" />
          <span className="shrink-0">
            {t(`agent.templates.scope.${template.scope}`)}
          </span>
          {template.schedule && (
            <>
              <LuRepeat className="ml-1.5 size-3 shrink-0" aria-hidden="true" />
              <span data-slot="agent-template-schedule" className="truncate">
                {scheduleWords({
                  cron: template.schedule,
                  timezone: localTimezone(),
                })}
              </span>
            </>
          )}
        </span>
        {template.asksFirst && (
          <>
            <span className="sr-only">{t("agent.templates.asksFirst")}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  data-slot="agent-template-asks"
                  aria-hidden="true"
                  className="absolute top-3 right-3 grid size-5 place-items-center text-muted-foreground"
                >
                  <LuHand className="size-3.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent>{t("agent.templates.asksFirst")}</TooltipContent>
            </Tooltip>
          </>
        )}
      </button>
    </li>
  );
}

function TemplateGrid({
  templates,
  onPick,
  label,
}: {
  templates: readonly AgentTemplate[];
  onPick: (template: AgentTemplate) => void;
  label?: string;
}) {
  return (
    <ul
      aria-label={label}
      className="grid grid-cols-1 gap-2 @[34rem]:grid-cols-2 @[56rem]:grid-cols-3"
    >
      {templates.map((template) => (
        <TemplateCard key={template.id} template={template} onPick={onPick} />
      ))}
    </ul>
  );
}

/** Every template: search, a category filter, and cards that fill the box. */
export function TemplateGallery({
  onPick,
}: {
  onPick: (template: AgentTemplate) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<TemplateCategory | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const shown = useMemo(() => {
    const inCategory = AGENT_TEMPLATES.filter(
      (template) => category === null || template.category === category,
    );
    if (!query.trim()) return inCategory;
    return inCategory
      .map((template) => {
        const copy = `agent.templates.items.${template.id}`;
        return {
          template,
          score: paletteScore(
            t(`${copy}.title`),
            [
              t(`${copy}.description`),
              t(`agent.templates.categories.${template.category}`),
              t(`${copy}.prompt`),
            ],
            query,
          ),
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.template);
  }, [category, query, t]);

  const grouped = category === null && !query.trim();

  return (
    <section
      data-slot="agent-templates"
      className="@container flex min-h-0 min-w-0 flex-1 flex-col gap-3"
    >
      <PaneHeader lead={<SidebarToggle />} title={t("agent.templates.title")} />
      <div className="mx-auto flex w-full max-w-4xl shrink-0 flex-col gap-2">
        <SearchField
          ref={searchRef}
          value={query}
          onChange={setQuery}
          placeholder={t("agent.templates.search")}
          slot="agent-templates-search"
          className="h-9"
        />
        <div
          role="group"
          aria-label={t("agent.templates.categoriesLabel")}
          className="-mx-2 flex flex-wrap items-center gap-0.5"
        >
          {[null, ...TEMPLATE_CATEGORIES].map((item) => {
            const on = category === item;
            return (
              <button
                key={item ?? "all"}
                type="button"
                aria-pressed={on}
                data-slot="agent-templates-category"
                data-category={item ?? "all"}
                onClick={() => {
                  setCategory(item);
                }}
                className={cn(
                  "inline-flex h-7 cursor-pointer items-center rounded-lg px-2 text-xs transition-colors duration-150 motion-reduce:transition-none",
                  FOCUS_RING,
                  on
                    ? "bg-foreground/8 text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item
                  ? t(`agent.templates.categories.${item}`)
                  : t("agent.templates.allCategories")}
              </button>
            );
          })}
        </div>
      </div>
      <FadingScrollArea className="-mx-1 min-h-0 flex-1 px-1">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 pb-4">
          {grouped ? (
            TEMPLATE_CATEGORIES.map((item) => (
              <div
                key={item}
                data-slot="agent-templates-section"
                className="flex flex-col gap-2"
              >
                <h4 className="px-1 text-xs font-medium text-muted-foreground">
                  {t(`agent.templates.categories.${item}`)}
                </h4>
                <TemplateGrid
                  label={t(`agent.templates.categories.${item}`)}
                  templates={shown.filter(
                    (template) => template.category === item,
                  )}
                  onPick={onPick}
                />
              </div>
            ))
          ) : shown.length > 0 ? (
            <TemplateGrid templates={shown} onPick={onPick} />
          ) : (
            <p
              data-slot="agent-templates-empty"
              className="px-1 py-6 text-center text-sm text-muted-foreground"
            >
              {t("agent.templates.noMatch")}
            </p>
          )}
        </div>
      </FadingScrollArea>
    </section>
  );
}
