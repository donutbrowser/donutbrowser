"use client";

import { invoke } from "@tauri-apps/api/core";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuCopy, LuTerminal } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { playUiSound } from "@/lib/ui-sounds";
import { cn } from "@/lib/utils";
import type { BrowserProfile } from "@/types";

interface DebugEndpoint {
  port: number;
  ws_url: string | null;
}

type Tool = "playwright" | "puppeteer";

const RETRY_MS = 2000;
const MAX_ATTEMPTS = 5;

function snippet(tool: Tool, endpoint: DebugEndpoint): string {
  const http = `http://127.0.0.1:${endpoint.port}`;
  if (tool === "playwright") {
    return [
      'import { chromium } from "playwright";',
      "",
      `const browser = await chromium.connectOverCDP("${http}");`,
      "const [context] = browser.contexts();",
    ].join("\n");
  }
  const target = endpoint.ws_url
    ? `browserWSEndpoint: "${endpoint.ws_url}"`
    : `browserURL: "${http}"`;
  return [
    'import puppeteer from "puppeteer-core";',
    "",
    `const browser = await puppeteer.connect({ ${target} });`,
  ].join("\n");
}

function CopyValueButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      playUiSound("copy");
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The clipboard refused; the value stays on screen to select by hand.
    }
  };

  return (
    <button
      type="button"
      aria-label={copied ? t("common.buttons.copied") : label}
      title={label}
      onClick={() => void copy()}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground",
        FOCUS_RING,
      )}
    >
      {copied ? (
        <LuCheck className="size-3.5 text-success-text" />
      ) : (
        <LuCopy className="size-3.5" />
      )}
    </button>
  );
}

function EndpointRow({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-foreground/4 py-1.5 pr-1.5 pl-3">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
        {value}
      </span>
      <CopyValueButton value={value} label={copyLabel} />
    </div>
  );
}

/**
 * Where an automation tool connects to this profile's running browser, with
 * the few lines Playwright and Puppeteer need.
 */
export function DebugEndpointBlock({
  profile,
  isRunning,
}: {
  profile: BrowserProfile;
  isRunning: boolean;
}) {
  const { t } = useTranslation();
  const [endpoint, setEndpoint] = React.useState<
    DebugEndpoint | null | undefined
  >(undefined);
  const [attempt, setAttempt] = React.useState(0);
  const [tool, setTool] = React.useState<Tool>("playwright");

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the Retry button, and a new attempt must read again
  React.useEffect(() => {
    if (!isRunning) {
      setEndpoint(undefined);
      return;
    }
    let current = true;
    let timer: number | undefined;
    let tries = 0;
    const read = async () => {
      tries += 1;
      try {
        const next = await invoke<DebugEndpoint | null>(
          "get_profile_debug_endpoint",
          { profileId: profile.id },
        );
        if (!current) return;
        setEndpoint(next);
        // A browser that just started may not hold its port or answer yet.
        if (!next?.ws_url && tries < MAX_ATTEMPTS) {
          timer = window.setTimeout(() => void read(), RETRY_MS);
        }
      } catch {
        if (current) setEndpoint(null);
      }
    };
    void read();
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [profile.id, isRunning, attempt]);

  const code = endpoint ? snippet(tool, endpoint) : "";

  return (
    <div data-slot="profile-debug-endpoint" className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <LuTerminal className="size-4" />
        <h3>{t("profileInfo.debug.title")}</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        {isRunning
          ? t("profileInfo.debug.description")
          : t("profileInfo.debug.notRunning")}
      </p>
      {isRunning && endpoint === undefined && (
        <p className="text-xs text-muted-foreground">
          {t("profileInfo.values.loading")}
        </p>
      )}
      {isRunning && endpoint === null && (
        <div className="flex items-center gap-2 rounded-lg bg-foreground/4 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 text-muted-foreground">
            {t("profileInfo.debug.unavailable")}
          </span>
          <Button
            variant="soft"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t("common.buttons.retry")}
          </Button>
        </div>
      )}
      {isRunning && endpoint && (
        <>
          <EndpointRow
            label={t("profileInfo.debug.port")}
            value={String(endpoint.port)}
            copyLabel={t("profileInfo.debug.copyPort")}
          />
          {endpoint.ws_url ? (
            <EndpointRow
              label={t("profileInfo.debug.wsUrl")}
              value={endpoint.ws_url}
              copyLabel={t("profileInfo.debug.copyWsUrl")}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("profileInfo.debug.wsPending")}
            </p>
          )}
          <div className="overflow-hidden rounded-lg bg-foreground/4">
            <div className="flex items-center gap-1 px-1.5 pt-1.5">
              {(["playwright", "puppeteer"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={tool === item}
                  onClick={() => setTool(item)}
                  className={cn(
                    "h-6 rounded-md px-2 text-xs transition-colors",
                    FOCUS_RING,
                    tool === item
                      ? "bg-foreground/8 text-foreground"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                  )}
                >
                  {item === "playwright" ? "Playwright" : "Puppeteer"}
                </button>
              ))}
              <span className="flex-1" />
              <CopyValueButton
                value={code}
                label={t("profileInfo.debug.copyCode", {
                  tool: tool === "playwright" ? "Playwright" : "Puppeteer",
                })}
              />
            </div>
            <pre
              data-slot="profile-debug-snippet"
              className="overflow-x-auto px-3 pt-2 pb-3 font-mono text-[11px] leading-relaxed"
            >
              {code}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
