"use client";

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Component, type ErrorInfo, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCopy, LuRotateCw, LuTriangleAlert } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { logRenderError } from "@/lib/logger";
import { cn } from "@/lib/utils";

/** The message and stack, for a bug report. */
function errorDetails(error: unknown, componentStack?: string | null): string {
  const text =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : String(error);
  return componentStack ? `${text}\n\nComponents:${componentStack}` : text;
}

/**
 * What a render error leaves on screen: what happened, Reload, and the
 * details to copy into a report. `fill` takes the whole window.
 */
export function ErrorScreen({
  error,
  componentStack,
  fill = false,
}: {
  error: unknown;
  componentStack?: string | null;
  fill?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const details = errorDetails(error, componentStack);
  const copy = async () => {
    try {
      await writeText(details);
    } catch {
      await navigator.clipboard?.writeText(details);
    }
    setCopied(true);
  };
  return (
    <div
      role="alert"
      data-slot="error-screen"
      className={cn(
        "flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto bg-background p-6 text-center text-foreground",
        fill && "h-dvh",
      )}
    >
      <span className="grid size-10 place-items-center rounded-xl bg-destructive/10 text-destructive-text">
        <LuTriangleAlert className="size-5" aria-hidden="true" />
      </span>
      <h1 className="text-sm font-semibold">{t("errorBoundary.title")}</h1>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        {t("errorBoundary.description")}
      </p>
      <p className="max-w-md truncate font-mono text-[11px] text-muted-foreground">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          size="sm"
          className="h-8 gap-1.5 rounded-lg text-xs"
          onClick={() => window.location.reload()}
        >
          <LuRotateCw className="size-3.5" aria-hidden="true" />
          {t("errorBoundary.reload")}
        </Button>
        <Button
          size="sm"
          variant="soft"
          className="h-8 gap-1.5 rounded-lg text-xs"
          onClick={() => void copy()}
        >
          <LuCopy className="size-3.5" aria-hidden="true" />
          {copied ? t("common.buttons.copied") : t("errorBoundary.copyDetails")}
        </Button>
      </div>
    </div>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /** A new value (the page) clears a caught error and renders again. */
  resetKey?: unknown;
  fill?: boolean;
}

interface ErrorBoundaryState {
  error: unknown;
  componentStack: string | null;
  resetKey: unknown;
}

/** Keeps a render error inside the part of the app it happened in. */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    error: null,
    componentStack: null,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: unknown) {
    return { error: error ?? new Error("Unknown render error") };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ) {
    if (props.resetKey === state.resetKey) return null;
    return { error: null, componentStack: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    logRenderError(error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorScreen
          error={this.state.error}
          componentStack={this.state.componentStack}
          fill={this.props.fill}
        />
      );
    }
    return this.props.children;
  }
}
