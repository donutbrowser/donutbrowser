"use client";

import { isMacOS } from "@/lib/platform";
import type { TipId } from "@/lib/tips";
import {
  ApiScene,
  ConsistencyScene,
  DnsScene,
  ExtensionsScene,
  FeedbackScene,
  GroupsScene,
  ImportScene,
  LinkRouteScene,
  LockScene,
  PaletteScene,
  ProxyRouteScene,
  SweepScene,
  SyncScene,
  TrashScene,
} from "./scenes-essentials";
import {
  AgentScene,
  CloudSyncScene,
  CookieBotScene,
  CrossOsScene,
  RemoteScene,
  SynchronizerScene,
  TeamScene,
} from "./scenes-plan";
import { RequireRouteScene, TotpScene, VpnScene } from "./scenes-safety";
import {
  SearchScene,
  ShortcutsScene,
  StatusesScene,
  TemplatesScene,
} from "./scenes-workflow";

/** The drawing for one tip. Every tip id has one; the switch is exhaustive. */
export function TipScene({ id }: { id: TipId }) {
  switch (id) {
    case "commandPalette":
      return <PaletteScene modLabel={isMacOS() ? "⌘" : "Ctrl"} />;
    case "searchSyntax":
      return <SearchScene />;
    case "shortcuts":
      return <ShortcutsScene />;
    case "groups":
      return <GroupsScene />;
    case "statuses":
      return <StatusesScene />;
    case "templates":
      return <TemplatesScene />;
    case "extensionGroups":
      return <ExtensionsScene />;
    case "importProfiles":
      return <ImportScene />;
    case "proxyCheck":
      return <ProxyRouteScene />;
    case "vpn":
      return <VpnScene />;
    case "dnsBlocklist":
      return <DnsScene />;
    case "fingerprintGate":
      return <ConsistencyScene />;
    case "requireRoute":
      return <RequireRouteScene />;
    case "profilePassword":
      return <LockScene />;
    case "clearOnClose":
      return <SweepScene />;
    case "totp":
      return <TotpScene />;
    case "trash":
      return <TrashScene />;
    case "selfHostedSync":
      return <SyncScene />;
    case "defaultBrowser":
      return <LinkRouteScene />;
    case "localApi":
      return <ApiScene variant="api" />;
    case "feedback":
      return <FeedbackScene />;
    case "cloudBackup":
      return <CloudSyncScene />;
    case "cookieBot":
      return <CookieBotScene />;
    case "crossOs":
      return <CrossOsScene />;
    case "synchronizer":
      return <SynchronizerScene />;
    case "automation":
      return <ApiScene variant="run" />;
    case "agent":
      return <AgentScene />;
    case "team":
      return <TeamScene />;
    case "remoteControl":
      return <RemoteScene />;
  }
}
