"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useTableFilters } from "@/hooks/use-table-tools";
import {
  matchesProfile,
  type ProfileSearchContext,
  parseProfileSearch,
} from "@/lib/profile-search";
import type { TableFilter } from "@/lib/table-tools";
import type { BrowserProfile } from "@/types";

const noTextSearch = () => "";

/** Every known exit country, by its name in the app's language. */
function countryOptions(
  countries: ReadonlyMap<string, string> | undefined,
  language: string,
) {
  const names = new Intl.DisplayNames([language], { type: "region" });
  const label = (code: string) => {
    try {
      return names.of(code) ?? code;
    } catch {
      return code;
    }
  };
  return [...new Set(countries?.values() ?? [])]
    .map((code) => ({ value: code, label: label(code) }))
    .sort((a, b) => a.label.localeCompare(b.label, language));
}

export function useProfileTableFilters(
  profiles: BrowserProfile[],
  query: string,
  context: ProfileSearchContext,
) {
  const { t, i18n } = useTranslation();
  const searched = useMemo(() => {
    const parsed = parseProfileSearch(query);
    return parsed.isEmpty
      ? profiles
      : profiles.filter((profile) => matchesProfile(profile, parsed, context));
  }, [profiles, query, context]);
  const definitions = useMemo<TableFilter<BrowserProfile>[]>(
    () => [
      {
        id: "status",
        label: t("search.fields.status"),
        value: (row) =>
          context.runningProfiles.has(row.id) ? "running" : "stopped",
        options: [
          { value: "running", label: t("tables.running") },
          { value: "stopped", label: t("tables.stopped") },
        ],
      },
      {
        id: "state",
        label: t("profileStatuses.column"),
        value: (row) => row.status_id ?? "",
        options: [
          { value: "", label: t("profileStatuses.none") },
          ...[...context.statusNames].map(([value, label]) => ({
            value,
            label,
          })),
        ],
      },
      {
        id: "tag",
        label: t("profileTable.tagsHeader"),
        value: (row) => (row.tags?.length ? row.tags : [""]),
        options: [
          { value: "", label: t("tables.noTags") },
          ...[...new Set(profiles.flatMap((row) => row.tags ?? []))]
            .sort()
            .map((value) => ({ value, label: value })),
        ],
      },
      {
        id: "proxy",
        label: t("profiles.table.proxy"),
        value: (row) => row.proxy_id ?? "",
        options: [
          { value: "", label: t("tables.noProxy") },
          ...[...context.proxyNames].map(([value, label]) => ({
            value,
            label,
          })),
        ],
      },
      {
        id: "country",
        label: t("search.fields.country"),
        value: (row) =>
          (row.proxy_id && context.proxyCountries?.get(row.proxy_id)) || "",
        options: [
          { value: "", label: t("profileInfo.values.unknown") },
          ...countryOptions(context.proxyCountries, i18n.language),
        ],
      },
      {
        id: "sync",
        label: t("proxies.management.syncCol"),
        value: (row) => row.sync_mode ?? "Disabled",
        options: [
          { value: "Disabled", label: t("tables.disabled") },
          { value: "Regular", label: t("tables.enabled") },
          { value: "Encrypted", label: t("tables.encrypted") },
        ],
      },
    ],
    [profiles, context, t, i18n.language],
  );
  return useTableFilters(searched, noTextSearch, definitions, "profiles");
}
