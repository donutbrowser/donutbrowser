"use client";

import type { IconType } from "react-icons";
import {
  LuActivity,
  LuBot,
  LuCloud,
  LuCode,
  LuCommand,
  LuCookie,
  LuEraser,
  LuFingerprint,
  LuFolders,
  LuImport,
  LuKeyboard,
  LuKeyRound,
  LuLayoutTemplate,
  LuLink,
  LuLock,
  LuMessageSquare,
  LuMonitor,
  LuMousePointerClick,
  LuPuzzle,
  LuRadioTower,
  LuServer,
  LuShield,
  LuShieldBan,
  LuTag,
  LuTerminal,
  LuTextSearch,
  LuTrash2,
  LuUnplug,
  LuUsers,
} from "react-icons/lu";
import type { TipId } from "@/lib/tips";

const ICONS: Record<TipId, IconType> = {
  commandPalette: LuCommand,
  searchSyntax: LuTextSearch,
  shortcuts: LuKeyboard,
  groups: LuFolders,
  statuses: LuTag,
  templates: LuLayoutTemplate,
  extensionGroups: LuPuzzle,
  importProfiles: LuImport,
  proxyCheck: LuActivity,
  vpn: LuShield,
  dnsBlocklist: LuShieldBan,
  fingerprintGate: LuFingerprint,
  requireRoute: LuUnplug,
  profilePassword: LuLock,
  clearOnClose: LuEraser,
  totp: LuKeyRound,
  trash: LuTrash2,
  selfHostedSync: LuServer,
  defaultBrowser: LuLink,
  localApi: LuTerminal,
  feedback: LuMessageSquare,
  cloudBackup: LuCloud,
  cookieBot: LuCookie,
  crossOs: LuMonitor,
  synchronizer: LuMousePointerClick,
  automation: LuCode,
  agent: LuBot,
  team: LuUsers,
  remoteControl: LuRadioTower,
};

/** The small mark a tip carries in lists and on the inline card. */
export function TipIcon({ id, className }: { id: TipId; className?: string }) {
  const Icon = ICONS[id];
  return <Icon aria-hidden="true" className={className} />;
}
