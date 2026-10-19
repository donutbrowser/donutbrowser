"use client";

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { IconType } from "react-icons";
import {
  LuArrowLeft,
  LuArrowUpRight,
  LuBug,
  LuCircleAlert,
  LuCircleArrowUp,
  LuCircleCheck,
  LuCopy,
  LuExternalLink,
  LuFolderOpen,
  LuGithub,
  LuGlobe,
  LuInfo,
  LuKeyboard,
  LuLoaderCircle,
  LuRefreshCw,
  LuScale,
  LuSearch,
} from "react-icons/lu";
import { DonutLab } from "@/components/donut-lab";
import { Button } from "@/components/ui/button";
import { ConfirmationMark } from "@/components/ui/confirmation-mark";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Input } from "@/components/ui/input";
import { StepTransition } from "@/components/ui/step-transition";
import licenses from "@/generated/licenses.json";
import xraySource from "@/generated/xray-source.json";
import type { AppUpdateState } from "@/hooks/use-app-update-notifications";
import { MOTION_EASE_OUT } from "@/lib/motion";
import { showErrorToast } from "@/lib/toast-utils";
import { playUiSound } from "@/lib/ui-sounds";
import { cn } from "@/lib/utils";
import { Logo } from "./icons/logo";

const WEBSITE_URL = "https://donutbrowser.com";
const REPOSITORY_URL = "https://github.com/donutbrowser/donutbrowser";
const RELEASES_URL = `${REPOSITORY_URL}/releases`;
/** A check older than this runs again when About opens. */
const CHECK_TTL_MS = 10 * 60 * 1000;
/** Three clicks on the logo, each this soon after the last, open the lab. */
const EGG_CLICK_GAP_MS = 600;
const EGG_CLICKS = 3;

interface SystemInfo {
  app_version: string;
  os: string;
  arch: string;
  portable: boolean;
}

type BuildChannel = "stable" | "nightly" | "development";

/** The channel, the version people read, and its release notes, from the build's version. */
function describeBuild(version: string) {
  if (version.startsWith("dev-")) {
    return {
      channel: "development" as BuildChannel,
      label: version.slice(4),
      notesUrl: RELEASES_URL,
    };
  }
  if (version.startsWith("nightly-")) {
    return {
      channel: "nightly" as BuildChannel,
      label: version.slice(8),
      notesUrl: RELEASES_URL,
    };
  }
  const label = version.replace(/^v/, "");
  return {
    channel: "stable" as BuildChannel,
    label,
    notesUrl: `${RELEASES_URL}/tag/v${label}`,
  };
}

type CheckState = "idle" | "checking" | "done" | "failed";

type AboutView = "about" | "licenses";

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
  update: AppUpdateState;
  onOpenFeedback: () => void;
  onOpenShortcuts: () => void;
}

export function AboutDialog({
  isOpen,
  onClose,
  update,
  onOpenFeedback,
  onOpenShortcuts,
}: AboutDialogProps) {
  const { t, i18n } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [wayfernVersions, setWayfernVersions] = useState<string[] | null>(null);
  const [view, setView] = useState<AboutView>("about");
  const [licenseQuery, setLicenseQuery] = useState("");
  const [check, setCheck] = useState<CheckState>("idle");
  const [copied, setCopied] = useState(false);
  const [lab, setLab] = useState<{ x: number; y: number } | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLButtonElement>(null);
  const logoClicksRef = useRef<number[]>([]);
  const lastCheckAtRef = useRef(0);
  const copiedTimerRef = useRef<number | undefined>(undefined);
  const restoreLicensesButtonFocusRef = useRef(false);
  const restoreLogoFocusRef = useRef(false);
  const diagnosticsId = useId();
  const helpId = useId();

  const build = useMemo(
    () => (systemInfo ? describeBuild(systemInfo.app_version) : null),
    [systemInfo],
  );
  const { checkForAppUpdatesManual } = update;

  useEffect(() => {
    if (!isOpen) return;
    invoke<SystemInfo>("get_system_info")
      .then(setSystemInfo)
      .catch(() => {
        setSystemInfo(null);
      });
    invoke<string[]>("get_downloaded_browser_versions", {
      browserStr: "wayfern",
    })
      .then(setWayfernVersions)
      .catch(() => {
        setWayfernVersions([]);
      });
  }, [isOpen]);

  const runCheck = useCallback(async () => {
    setCheck("checking");
    lastCheckAtRef.current = Date.now();
    try {
      await checkForAppUpdatesManual();
      setCheck("done");
    } catch (error) {
      console.error("Failed to check for app updates:", error);
      setCheck("failed");
    }
  }, [checkForAppUpdatesManual]);

  // Opening About checks for an update, unless one is known or a check ran lately.
  const channel = build?.channel;
  const knownUpdate = update.updateInfo !== null;
  useEffect(() => {
    if (!isOpen || !channel || channel === "development" || knownUpdate) {
      return;
    }
    if (check === "checking") return;
    if (
      check !== "idle" &&
      Date.now() - lastCheckAtRef.current < CHECK_TTL_MS
    ) {
      return;
    }
    void runCheck();
  }, [isOpen, channel, knownUpdate, check, runCheck]);

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), []);

  const details = useMemo(() => {
    if (!systemInfo || !build) return "";
    return [
      `Donut Browser ${systemInfo.app_version}`,
      `Channel: ${build.channel}`,
      `System: ${systemInfo.os} ${systemInfo.arch}`,
      `Wayfern: ${wayfernVersions?.length ? wayfernVersions.join(", ") : "none"}`,
      `Portable: ${systemInfo.portable ? "yes" : "no"}`,
      `Language: ${i18n.language}`,
    ].join("\n");
  }, [systemInfo, build, wayfernVersions, i18n.language]);

  const copyDetails = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(details);
      playUiSound("copy");
      setCopied(true);
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy details:", error);
      showErrorToast(t("about.diagnostics.copyFailed"));
    }
  }, [details, t]);

  const openLogs = useCallback(async () => {
    try {
      await invoke("open_log_directory");
    } catch (error) {
      console.error("Failed to open the log folder:", error);
      showErrorToast(t("about.diagnostics.openLogsFailed"));
    }
  }, [t]);

  const closeLab = useCallback(() => {
    restoreLogoFocusRef.current = true;
    setLab(null);
  }, []);

  useEffect(() => {
    if (lab || !restoreLogoFocusRef.current) return;
    restoreLogoFocusRef.current = false;
    logoRef.current?.focus();
  }, [lab]);

  const handleLogoClick = useCallback(() => {
    const now = performance.now();
    const clicks = logoClicksRef.current;
    const last = clicks[clicks.length - 1];
    if (last !== undefined && now - last > EGG_CLICK_GAP_MS) clicks.length = 0;
    clicks.push(now);
    const logo = logoRef.current;
    if (clicks.length >= EGG_CLICKS && logo) {
      clicks.length = 0;
      const rect = logo.getBoundingClientRect();
      contentRef.current?.scrollTo({ top: 0 });
      setLab({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      return;
    }
    // Each press squeezes a little harder, as if something were inside.
    if (!reducedMotion && logo && typeof logo.animate === "function") {
      const depth = clicks.length;
      logo.animate(
        [
          { transform: "scale(1) rotate(0deg)" },
          {
            transform: `scale(${0.93 - depth * 0.03}) rotate(${depth * -7}deg)`,
          },
          { transform: "scale(1) rotate(0deg)" },
        ],
        {
          duration: 240,
          easing: `cubic-bezier(${MOTION_EASE_OUT.join(",")})`,
        },
      );
    }
  }, [reducedMotion]);

  const handleClose = useCallback(() => {
    setLab(null);
    logoClicksRef.current = [];
    restoreLogoFocusRef.current = false;
    setView("about");
    setLicenseQuery("");
    restoreLicensesButtonFocusRef.current = false;
    onClose();
  }, [onClose]);

  const handleLicensesButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (node && restoreLicensesButtonFocusRef.current) {
        restoreLicensesButtonFocusRef.current = false;
        node.focus();
      }
    },
    [],
  );

  const handleBackToAbout = useCallback(() => {
    restoreLicensesButtonFocusRef.current = true;
    setLicenseQuery("");
    setView("about");
  }, []);

  const filteredLicenses = useMemo(() => {
    const query = licenseQuery.trim().toLocaleLowerCase();
    if (!query) return licenses;
    return licenses.filter(
      ({ name, license }) =>
        name.toLocaleLowerCase().includes(query) ||
        license.toLocaleLowerCase().includes(query),
    );
  }, [licenseQuery]);

  const meta = systemInfo
    ? [
        build?.label,
        build && t(`about.channel.${build.channel}`),
        `${systemInfo.os} ${systemInfo.arch}`,
        systemInfo.portable ? t("about.portable") : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent
        ref={contentRef}
        hideClose={lab !== null}
        onEscapeKeyDown={(event) => {
          if (!lab) return;
          event.preventDefault();
          closeLab();
        }}
        className={cn(
          "max-w-2xl",
          view === "licenses"
            ? "flex h-[min(80dvh,40rem)] flex-col overflow-hidden"
            : "@container",
          lab && "overflow-hidden",
        )}
      >
        <StepTransition
          transitionKey={view}
          direction={view === "about" ? -1 : 1}
          className={
            view === "licenses"
              ? "flex min-h-0 flex-1 flex-col gap-4"
              : "grid gap-5"
          }
        >
          {view === "about" ? (
            <div inert={lab !== null} className="contents">
              <header className="flex items-start gap-4 pr-8">
                <button
                  ref={logoRef}
                  type="button"
                  data-slot="about-logo"
                  aria-label={t("header.donutLogo")}
                  onClick={handleLogoClick}
                  className={cn(
                    "grid size-14 shrink-0 cursor-pointer place-items-center rounded-2xl bg-foreground/5 text-foreground select-none",
                    FOCUS_RING,
                  )}
                >
                  <Logo className="size-9" aria-hidden="true" />
                </button>
                <div className="min-w-0 flex-1 pt-0.5">
                  <DialogTitle className="text-lg leading-tight">
                    Donut Browser
                  </DialogTitle>
                  <p
                    data-slot="about-build"
                    className="mt-1 min-h-4 text-xs text-muted-foreground"
                  >
                    {meta}
                  </p>
                  {build && (
                    <LinkButton
                      className="mt-1.5"
                      onClick={() => void openUrl(build.notesUrl)}
                    >
                      {t("about.whatsNew")}
                    </LinkButton>
                  )}
                </div>
              </header>

              <UpdateStatus
                channel={build?.channel ?? null}
                check={check}
                update={update}
                onCheck={() => void runCheck()}
              />

              <div className="grid gap-4 @lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
                <section
                  data-slot="about-diagnostics"
                  aria-labelledby={diagnosticsId}
                  className="rounded-lg bg-foreground/[0.035] p-3"
                >
                  <SectionLabel id={diagnosticsId}>
                    {t("about.diagnostics.title")}
                  </SectionLabel>
                  <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
                    <DiagnosticRow label={t("about.diagnostics.version")}>
                      {systemInfo?.app_version}
                    </DiagnosticRow>
                    <DiagnosticRow label={t("about.diagnostics.channel")}>
                      {build && t(`about.channel.${build.channel}`)}
                    </DiagnosticRow>
                    <DiagnosticRow label={t("about.diagnostics.system")}>
                      {systemInfo && `${systemInfo.os} ${systemInfo.arch}`}
                    </DiagnosticRow>
                    <DiagnosticRow label="Wayfern">
                      {wayfernVersions &&
                        (wayfernVersions.length > 0
                          ? wayfernVersions.join(", ")
                          : t("about.diagnostics.notInstalled"))}
                    </DiagnosticRow>
                    <DiagnosticRow label={t("about.portable")}>
                      {systemInfo &&
                        (systemInfo.portable
                          ? t("about.diagnostics.yes")
                          : t("about.diagnostics.no"))}
                    </DiagnosticRow>
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="soft"
                      data-slot="about-copy-details"
                      disabled={!details}
                      onClick={() => void copyDetails()}
                    >
                      {copied ? (
                        <ConfirmationMark />
                      ) : (
                        <LuCopy aria-hidden="true" />
                      )}
                      <span aria-live="polite">
                        {copied
                          ? t("common.buttons.copied")
                          : t("about.diagnostics.copy")}
                      </span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="subtle"
                      onClick={() => void openLogs()}
                    >
                      <LuFolderOpen aria-hidden="true" />
                      {t("about.diagnostics.openLogs")}
                    </Button>
                  </div>
                </section>

                <nav aria-labelledby={helpId} className="px-1 @lg:pt-3">
                  <SectionLabel id={helpId} className="px-2">
                    {t("about.help.title")}
                  </SectionLabel>
                  <ul className="mt-1.5 grid gap-0.5">
                    <HelpItem icon={LuBug} onClick={onOpenFeedback}>
                      {t("about.help.reportBug")}
                    </HelpItem>
                    <HelpItem icon={LuKeyboard} onClick={onOpenShortcuts}>
                      {t("rail.more.keyboardShortcuts")}
                    </HelpItem>
                    <HelpItem
                      icon={LuScale}
                      buttonRef={handleLicensesButtonRef}
                      onClick={() => {
                        setLicenseQuery("");
                        setView("licenses");
                      }}
                    >
                      {t("about.licenses")}
                    </HelpItem>
                    <HelpItem
                      icon={LuGlobe}
                      external
                      onClick={() => void openUrl(WEBSITE_URL)}
                    >
                      {t("about.website")}
                    </HelpItem>
                  </ul>
                </nav>
              </div>

              <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-3 text-[11px] text-muted-foreground">
                <p>{t("about.footer")}</p>
                <LinkButton onClick={() => void openUrl(REPOSITORY_URL)}>
                  <LuGithub aria-hidden="true" className="size-3.5" />
                  {t("about.sourceCode")}
                </LinkButton>
              </footer>
            </div>
          ) : (
            <>
              <DialogHeader className="flex-row items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="-ml-2 size-8"
                  aria-label={t("common.buttons.back")}
                  onClick={handleBackToAbout}
                >
                  <LuArrowLeft aria-hidden="true" />
                </Button>
                <DialogTitle>{t("about.licenses")}</DialogTitle>
              </DialogHeader>

              <div className="relative shrink-0">
                <LuSearch
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  autoFocus
                  type="search"
                  variant="soft"
                  value={licenseQuery}
                  onChange={(event) => {
                    setLicenseQuery(event.target.value);
                  }}
                  aria-label={t("about.searchLicenses")}
                  placeholder={t("about.searchLicenses")}
                  className="pl-9"
                />
              </div>

              <FadingScrollArea
                role="region"
                tabIndex={0}
                aria-label={t("about.licenses")}
                className="-mx-2 min-h-0 flex-1 rounded-md px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {filteredLicenses.length > 0 ? (
                  <ul>
                    {filteredLicenses.map(({ name, license }) => (
                      <li
                        key={`${name}-${license}`}
                        className="grid grid-cols-[minmax(0,1fr)_minmax(7rem,45%)] items-baseline gap-3 rounded-md px-2 py-2 hover:bg-foreground/5"
                      >
                        {name === "Xray-core" ? (
                          <button
                            type="button"
                            onClick={() => void openUrl(xraySource.sourceUrl)}
                            aria-label={t("about.openSource", { name })}
                            title={t("about.openSource", { name })}
                            className="flex min-w-0 items-center gap-1.5 rounded-sm text-left text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] motion-reduce:transform-none"
                          >
                            <span className="truncate">{name}</span>
                            <LuExternalLink
                              aria-hidden="true"
                              className="size-3.5 shrink-0 text-muted-foreground"
                            />
                          </button>
                        ) : (
                          <span
                            className="truncate text-sm font-medium text-foreground"
                            title={name}
                          >
                            {name}
                          </span>
                        )}
                        <code className="break-words text-right font-mono text-xs text-muted-foreground">
                          {license}
                        </code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p
                    role="status"
                    className="py-12 text-center text-sm text-muted-foreground"
                  >
                    {t("about.noMatchingLicenses")}
                  </p>
                )}
              </FadingScrollArea>
            </>
          )}
        </StepTransition>
        {lab && view === "about" && (
          <DonutLab origin={lab} onClose={closeLab} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SectionLabel({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <h3
      id={id}
      className={cn(
        "text-[11px] font-medium tracking-wide text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </h3>
  );
}

function DiagnosticRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className="min-h-4 truncate font-mono text-foreground"
        title={typeof children === "string" ? children : undefined}
      >
        {children}
      </dd>
    </>
  );
}

function LinkButton({
  className,
  onClick,
  children,
}: {
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline",
        FOCUS_RING,
        className,
      )}
    >
      {children}
      <LuArrowUpRight aria-hidden="true" className="size-3 shrink-0" />
    </button>
  );
}

function HelpItem({
  icon: Icon,
  external = false,
  buttonRef,
  onClick,
  children,
}: {
  icon: IconType;
  external?: boolean;
  buttonRef?: (node: HTMLButtonElement | null) => void;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <li>
      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        className={cn(
          "group flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm text-foreground transition-colors hover:bg-foreground/5",
          FOCUS_RING,
        )}
      >
        <Icon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
        />
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {external && (
          <LuArrowUpRight
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        )}
      </button>
    </li>
  );
}

function UpdateStatus({
  channel,
  check,
  update,
  onCheck,
}: {
  channel: BuildChannel | null;
  check: CheckState;
  update: AppUpdateState;
  onCheck: () => void;
}) {
  const { t } = useTranslation();
  const info = update.updateInfo;
  const percent = update.updateProgress?.percentage;

  let state: string;
  let icon: ReactNode;
  let text: string;
  let action: ReactNode = null;

  const spinner = (
    <LuLoaderCircle
      aria-hidden="true"
      className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
    />
  );
  const arrow = (
    <LuCircleArrowUp aria-hidden="true" className="size-4 text-primary-text" />
  );

  if (channel === null) {
    state = "loading";
    icon = spinner;
    text = t("about.update.checking");
  } else if (channel === "development") {
    state = "development";
    icon = (
      <LuInfo aria-hidden="true" className="size-4 text-muted-foreground" />
    );
    text = t("about.update.development");
  } else if (info && update.updateReady) {
    state = "ready";
    icon = arrow;
    text = t("about.update.ready", { version: info.new_version });
    action = (
      <Button
        type="button"
        size="sm"
        onClick={() => void update.restartToUpdate()}
      >
        {t("about.update.restart")}
      </Button>
    );
  } else if (info && update.isUpdating) {
    state = "downloading";
    icon = spinner;
    text =
      typeof percent === "number"
        ? t("about.update.downloadingPercent", {
            version: info.new_version,
            percent: Math.round(percent),
          })
        : t("about.update.downloading", { version: info.new_version });
  } else if (info?.repo_update) {
    state = "available";
    icon = arrow;
    text = t("about.update.packageManager", { version: info.new_version });
  } else if (info) {
    state = "available";
    icon = arrow;
    text = t("about.update.available", { version: info.new_version });
    action = info.manual_update_required ? (
      <Button
        type="button"
        size="sm"
        onClick={() => void openUrl(info.release_page_url ?? info.download_url)}
      >
        {t("about.update.download")}
        <LuArrowUpRight aria-hidden="true" />
      </Button>
    ) : (
      <Button
        type="button"
        size="sm"
        onClick={() => void update.installAppUpdate(info)}
      >
        {t("about.update.update")}
      </Button>
    );
  } else if (check === "failed") {
    state = "failed";
    icon = (
      <LuCircleAlert
        aria-hidden="true"
        className="size-4 text-muted-foreground"
      />
    );
    text = t("about.update.failed");
    action = (
      <Button type="button" size="sm" variant="subtle" onClick={onCheck}>
        <LuRefreshCw aria-hidden="true" />
        {t("common.buttons.retry")}
      </Button>
    );
  } else if (check === "done") {
    state = "current";
    icon = (
      <LuCircleCheck aria-hidden="true" className="size-4 text-success-text" />
    );
    text = t("about.update.current");
    action = (
      <Button type="button" size="sm" variant="subtle" onClick={onCheck}>
        <LuRefreshCw aria-hidden="true" />
        {t("about.update.checkAgain")}
      </Button>
    );
  } else {
    state = "checking";
    icon = spinner;
    text = t("about.update.checking");
  }

  return (
    <div
      data-slot="about-update-status"
      data-state={state}
      className="flex min-h-12 items-center gap-3 rounded-lg bg-foreground/[0.035] py-2 pr-2 pl-3"
    >
      <span className="grid size-4 shrink-0 place-items-center">{icon}</span>
      <p role="status" className="min-w-0 flex-1 text-sm text-foreground">
        {text}
      </p>
      {action}
    </div>
  );
}
