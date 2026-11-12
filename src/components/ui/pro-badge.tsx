"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { PRICING_URL } from "@/lib/plan-labels";
import { cn } from "@/lib/utils";

/** Controls a badge can sit inside; a button there would nest controls. */
const INTERACTIVE_PARENT =
  'button, a, label, [role="option"], [role="menuitem"], [role="tab"], [role="radio"]';

const BADGE_CLASS =
  "rounded bg-primary px-1 py-0.5 text-[11px] font-semibold text-primary-foreground";

/**
 * Marks a feature of the paid plans. On its own it opens the plans page;
 * inside another control (a menu item, an option) it is only a label.
 */
export function ProBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement>(null);
  const [nested, setNested] = useState(false);

  useLayoutEffect(() => {
    setNested(Boolean(ref.current?.parentElement?.closest(INTERACTIVE_PARENT)));
  }, []);

  if (nested) {
    return (
      <span ref={ref} className={cn(BADGE_CLASS, className)}>
        {t("pro.badge")}
      </span>
    );
  }
  return (
    <button
      ref={ref as React.RefObject<HTMLButtonElement>}
      type="button"
      data-slot="pro-badge"
      aria-label={t("pro.seePlans")}
      title={t("pro.seePlans")}
      onClick={(event) => {
        event.stopPropagation();
        void openUrl(PRICING_URL);
      }}
      className={cn(
        BADGE_CLASS,
        "cursor-pointer transition-colors duration-100 hover:bg-primary/85",
        FOCUS_RING,
        className,
      )}
    >
      {t("pro.badge")}
    </button>
  );
}
