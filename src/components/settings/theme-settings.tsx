"use client";

import Color from "color";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LuMonitor, LuMoon, LuPalette, LuPipette, LuSun } from "react-icons/lu";
import {
  ChoiceCard,
  ChoiceGroup,
} from "@/components/settings/settings-primitives";
import {
  ColorPicker,
  ColorPickerAlpha,
  ColorPickerEyeDropper,
  ColorPickerFormat,
  ColorPickerHue,
  ColorPickerOutput,
  ColorPickerSelection,
} from "@/components/ui/color-picker";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getThemeByColors, THEME_VARIABLES, THEMES } from "@/lib/themes";
import { cn } from "@/lib/utils";

/**
 * A small drawing of the app in one palette: the rail, a header with its
 * primary button, and a few profile rows. `scheme` scopes the built-in light
 * or dark palette; `colors` scopes a preset's.
 */
export function ThemePreview({
  scheme,
  colors,
  className,
}: {
  scheme?: "light" | "dark";
  colors?: Record<string, string>;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        scheme,
        "flex aspect-[16/10] w-full overflow-hidden rounded-lg bg-background text-foreground ring-1 ring-foreground/10",
        className,
      )}
      style={colors as CSSProperties | undefined}
    >
      <div className="flex w-[17%] flex-col items-center gap-[9%] bg-foreground/5 pt-[9%]">
        <span className="size-[22%] rounded-full bg-primary" />
        <span className="size-[18%] rounded-full bg-foreground/25" />
        <span className="size-[18%] rounded-full bg-foreground/25" />
        <span className="size-[18%] rounded-full bg-foreground/25" />
      </div>
      <div className="flex flex-1 flex-col gap-[7%] p-[7%]">
        <div className="flex items-center gap-[6%]">
          <span className="h-1.5 w-[38%] rounded-full bg-foreground/80" />
          <span className="ml-auto h-2.5 w-[24%] rounded-[3px] bg-primary" />
        </div>
        {[0.55, 0.4, 0.48].map((width, index) => (
          <div
            key={width}
            className="flex items-center gap-[5%] rounded-[3px] bg-card px-[5%] py-[4%] ring-1 ring-border"
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                index === 1 ? "bg-warning" : "bg-success",
              )}
            />
            <span
              className="h-1 rounded-full bg-foreground/45"
              style={{ width: `${width * 100}%` }}
            />
            <span className="ml-auto h-1 w-[14%] rounded-full bg-muted-foreground/40" />
          </div>
        ))}
      </div>
    </div>
  );
}

function SystemPreview() {
  return (
    <div className="relative">
      <ThemePreview scheme="light" />
      <ThemePreview
        scheme="dark"
        className="absolute inset-0 [clip-path:polygon(62%_0,100%_0,100%_100%,38%_100%)]"
      />
    </div>
  );
}

function CardCaption({
  icon,
  children,
}: {
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 px-1 pt-2 pb-0.5 text-xs font-medium text-muted-foreground transition-colors duration-150 group-hover/choice:text-foreground group-data-[state=checked]/choice:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

const CARD_CLASS =
  "p-1.5 hover:bg-foreground/4 data-[state=unchecked]:hover:-translate-y-px";

/** Light, Dark, System and Custom, each drawn in its own palette. */
export function ThemeModePicker({
  value,
  onValueChange,
  customColors,
}: {
  value: string;
  onValueChange: (value: string) => void;
  customColors: Record<string, string>;
}) {
  const { t } = useTranslation();
  return (
    <ChoiceGroup
      value={value}
      onValueChange={onValueChange}
      label={t("settings.appearance.theme")}
      slot="settings-theme"
      className="grid grid-cols-2 gap-2 @lg:grid-cols-4"
    >
      <ChoiceCard
        value="light"
        slot="settings-theme-option"
        className={CARD_CLASS}
      >
        <ThemePreview scheme="light" />
        <CardCaption icon={<LuSun />}>
          {t("settings.appearance.light")}
        </CardCaption>
      </ChoiceCard>
      <ChoiceCard
        value="dark"
        slot="settings-theme-option"
        className={CARD_CLASS}
      >
        <ThemePreview scheme="dark" />
        <CardCaption icon={<LuMoon />}>
          {t("settings.appearance.dark")}
        </CardCaption>
      </ChoiceCard>
      <ChoiceCard
        value="system"
        slot="settings-theme-option"
        className={CARD_CLASS}
      >
        <SystemPreview />
        <CardCaption icon={<LuMonitor />}>
          {t("settings.appearance.system")}
        </CardCaption>
      </ChoiceCard>
      <ChoiceCard
        value="custom"
        slot="settings-theme-option"
        className={CARD_CLASS}
      >
        <ThemePreview colors={customColors} />
        <CardCaption icon={<LuPalette />}>
          {t("common.labels.custom")}
        </CardCaption>
      </ChoiceCard>
    </ChoiceGroup>
  );
}

/** Every preset drawn in its own colors, plus the user's own palette. */
export function ThemePresetGallery({
  selectedId,
  colors,
  onSelect,
}: {
  selectedId: string | null;
  colors: Record<string, string>;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <ChoiceGroup
      value={selectedId ?? "custom"}
      onValueChange={(value) => onSelect(value === "custom" ? null : value)}
      label={t("settings.appearance.themePreset")}
      slot="settings-theme-presets"
      className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1.5"
    >
      {THEMES.map((theme) => (
        <ChoiceCard
          key={theme.id}
          value={theme.id}
          slot="settings-theme-preset"
          className={CARD_CLASS}
        >
          <ThemePreview colors={theme.colors} />
          <CardCaption>{theme.name}</CardCaption>
        </ChoiceCard>
      ))}
      <ChoiceCard
        value="custom"
        slot="settings-theme-preset"
        className={CARD_CLASS}
      >
        <ThemePreview colors={colors} />
        <CardCaption icon={<LuPipette />}>
          {t("settings.appearance.yourOwn")}
        </CardCaption>
      </ChoiceCard>
    </ChoiceGroup>
  );
}

/** Every theme color as a chip that opens a picker. */
export function ThemeColorEditor({
  colors,
  onChange,
}: {
  colors: Record<string, string>;
  onChange: (next: {
    colors: Record<string, string>;
    presetId: string | null;
  }) => void;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-1.5">
      {THEME_VARIABLES.map(({ key, label }) => {
        const value = colors[key] ?? "#000000";
        return (
          <Popover key={key}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={label}
                className={cn(
                  "flex min-w-0 cursor-pointer items-center gap-2 rounded-lg bg-foreground/4 p-1.5 pr-2 text-left transition-colors duration-150 hover:bg-foreground/7 aria-expanded:bg-foreground/8",
                  FOCUS_RING,
                )}
              >
                <span
                  className="size-6 shrink-0 rounded-md shadow-sm ring-1 ring-foreground/15"
                  style={{ backgroundColor: value }}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-xs font-medium">{label}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground uppercase">
                    {value}
                  </span>
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-[320px] p-3" sideOffset={6}>
              <ColorPicker
                className="rounded-md border bg-background p-3 shadow-sm"
                value={value}
                onColorChange={([r, g, b, a]) => {
                  const next = {
                    ...colors,
                    [key]: Color({ r, g, b }).alpha(a).hexa(),
                  };
                  onChange({
                    colors: next,
                    presetId: getThemeByColors(next)?.id ?? null,
                  });
                }}
              >
                <ColorPickerSelection className="h-36 rounded" />
                <div className="mt-3 flex items-center gap-3">
                  <ColorPickerEyeDropper />
                  <div className="grid w-full gap-1">
                    <ColorPickerHue />
                    <ColorPickerAlpha />
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <ColorPickerOutput />
                  <ColorPickerFormat />
                </div>
              </ColorPicker>
            </PopoverContent>
          </Popover>
        );
      })}
    </div>
  );
}
