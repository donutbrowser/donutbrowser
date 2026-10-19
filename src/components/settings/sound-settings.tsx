"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuPlay } from "react-icons/lu";
import {
  ChoiceCard,
  ChoiceGroup,
  SettingBlock,
  SettingRow,
  SettingSlider,
} from "@/components/settings/settings-primitives";
import { AnimatedDisclosureContent } from "@/components/ui/animated-disclosure";
import { AnimatedSwitch } from "@/components/ui/animated-switch";
import { Button } from "@/components/ui/button";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_EASE_OUT } from "@/lib/motion";
import {
  DEFAULT_SOUND_PACK,
  DEFAULT_SOUND_VOLUME,
  previewUiSound,
  SOUND_CATEGORIES,
  SOUND_PACKS,
  type SoundSettings,
  type UiSound,
} from "@/lib/ui-sounds";
import { cn } from "@/lib/utils";

/** The sound settings with their saved defaults filled in. */
export function soundDraft(settings: SoundSettings): Required<SoundSettings> {
  return {
    ui_sounds: settings.ui_sounds ?? true,
    ui_sound_volume: settings.ui_sound_volume ?? DEFAULT_SOUND_VOLUME,
    ui_sound_interface: settings.ui_sound_interface ?? true,
    ui_sound_feedback: settings.ui_sound_feedback ?? true,
    ui_sound_events: settings.ui_sound_events ?? true,
    ui_sound_pack: settings.ui_sound_pack ?? DEFAULT_SOUND_PACK,
  };
}

const CATEGORY_KEYS = {
  interface: "ui_sound_interface",
  feedback: "ui_sound_feedback",
  events: "ui_sound_events",
} as const;

/**
 * A speaker whose waves draw out when sound turns on and fold away when it
 * turns off, with a cross in their place.
 */
function SpeakerGlyph({ on }: { on: boolean }) {
  const animate = useMotionAllowed();
  const transition = (delay: number) =>
    animate
      ? { duration: 0.28, delay, ease: MOTION_EASE_OUT }
      : { duration: 0 };
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg transition-colors duration-200",
        on
          ? "bg-primary/12 text-primary-text"
          : "bg-foreground/6 text-muted-foreground",
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z" />
        <motion.path
          d="M16 9a5 5 0 0 1 0 6"
          initial={false}
          animate={{ pathLength: on ? 1 : 0, opacity: on ? 1 : 0 }}
          transition={transition(on ? 0 : 0.06)}
        />
        <motion.path
          d="M19.4 5.6a10 10 0 0 1 0 12.8"
          initial={false}
          animate={{ pathLength: on ? 1 : 0, opacity: on ? 1 : 0 }}
          transition={transition(on ? 0.08 : 0)}
        />
        <motion.path
          d="m16 9.5 5 5m0-5-5 5"
          initial={false}
          animate={{ pathLength: on ? 0 : 1, opacity: on ? 0 : 1 }}
          transition={transition(on ? 0 : 0.14)}
        />
      </svg>
    </span>
  );
}

/** Four bars that jump once each time `beat` changes, like a level meter. */
function Bars({ beat, active }: { beat: number; active: boolean }) {
  const animate = useMotionAllowed();
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-4 items-end gap-[2px] transition-colors duration-200",
        active ? "text-primary-text" : "text-muted-foreground/60",
      )}
    >
      {[0.45, 0.85, 0.6, 0.35].map((rest, index) => (
        <motion.span
          key={`${index}-${beat}`}
          className="block h-full w-[3px] origin-bottom rounded-full bg-current"
          initial={{ scaleY: rest }}
          animate={
            animate && beat > 0
              ? { scaleY: [rest, 1, rest * 0.6, rest] }
              : { scaleY: rest }
          }
          transition={{
            duration: 0.5,
            delay: index * 0.04,
            ease: MOTION_EASE_OUT,
          }}
        />
      ))}
    </span>
  );
}

/** Volume in steps of five. */
const VOLUME_STOPS = Array.from({ length: 21 }, (_, index) => index * 5);

/** Interface sounds: on or off, how loud, which set, and which kinds. */
export function SoundSettings({
  draft,
  onChange,
  isChanged,
}: {
  draft: Required<SoundSettings>;
  onChange: (patch: Partial<SoundSettings>) => void;
  isChanged: (key: keyof SoundSettings) => boolean;
}) {
  const { t } = useTranslation();
  const [beats, setBeats] = useState<Record<string, number>>({});
  const play = (sound: UiSound, next: Partial<SoundSettings>, beat: string) => {
    previewUiSound(sound, { ...draft, ...next });
    setBeats((prev) => ({ ...prev, [beat]: (prev[beat] ?? 0) + 1 }));
  };
  const sample = SOUND_CATEGORIES[0].sample;

  return (
    <>
      <SettingRow
        htmlFor="settings-ui-sounds"
        label={t("settings.sounds.enabled")}
        description={t("settings.sounds.enabledDescription")}
        changed={isChanged("ui_sounds")}
        icon={<SpeakerGlyph on={draft.ui_sounds} />}
      >
        <AnimatedSwitch
          id="settings-ui-sounds"
          data-slot="settings-ui-sounds"
          aria-label={t("settings.sounds.enabled")}
          checked={draft.ui_sounds}
          onCheckedChange={(v) => onChange({ ui_sounds: v === true })}
        />
      </SettingRow>
      <AnimatedDisclosureContent
        open={draft.ui_sounds}
        className="divide-y divide-foreground/6"
      >
        <SettingRow
          label={t("settings.sounds.volume")}
          changed={isChanged("ui_sound_volume")}
        >
          <SettingSlider
            slot="settings-sound-volume"
            value={draft.ui_sound_volume}
            stops={VOLUME_STOPS}
            label={t("settings.sounds.volume")}
            format={(value) => `${value}%`}
            onChange={(value) => onChange({ ui_sound_volume: value })}
            onCommit={(value) =>
              play(sample, { ui_sound_volume: value }, "volume")
            }
          />
        </SettingRow>
        <SettingBlock
          label={t("settings.sounds.pack")}
          changed={isChanged("ui_sound_pack")}
        >
          {/* A pack card plays its own preview, so the press stays silent. */}
          <div data-sound="off">
            <ChoiceGroup
              value={draft.ui_sound_pack}
              onValueChange={(id) => {
                onChange({ ui_sound_pack: id });
                play(sample, { ui_sound_pack: id }, id);
              }}
              label={t("settings.sounds.pack")}
              slot="settings-sound-pack"
              className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-1.5"
            >
              {SOUND_PACKS.map(({ id }) => (
                <ChoiceCard
                  key={id}
                  value={id}
                  slot="settings-sound-pack-option"
                  className="flex items-start gap-3 px-3 py-2.5 hover:bg-foreground/4"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {t(`settings.sounds.packs.${id}.label`)}
                    </span>
                    <span className="text-xs leading-snug text-muted-foreground">
                      {t(`settings.sounds.packs.${id}.description`)}
                    </span>
                  </span>
                  <Bars
                    beat={beats[id] ?? 0}
                    active={draft.ui_sound_pack === id}
                  />
                </ChoiceCard>
              ))}
            </ChoiceGroup>
          </div>
        </SettingBlock>
        {SOUND_CATEGORIES.map((category) => {
          const key = CATEGORY_KEYS[category.id];
          const id = `settings-sound-${category.id}`;
          return (
            <SettingRow
              key={category.id}
              htmlFor={id}
              label={t(`settings.sounds.categories.${category.id}.label`)}
              description={t(
                `settings.sounds.categories.${category.id}.description`,
              )}
              changed={isChanged(key)}
            >
              <Button
                variant="subtle"
                size="icon"
                className="size-8"
                aria-label={t("settings.sounds.previewAria", {
                  name: t(`settings.sounds.categories.${category.id}.label`),
                })}
                title={t("settings.sounds.preview")}
                data-sound="off"
                onClick={() => play(category.sample, {}, category.id)}
              >
                <LuPlay className="size-3.5" />
              </Button>
              <AnimatedSwitch
                id={id}
                aria-label={t(
                  `settings.sounds.categories.${category.id}.label`,
                )}
                checked={draft[key]}
                onCheckedChange={(v) => onChange({ [key]: v === true })}
              />
            </SettingRow>
          );
        })}
      </AnimatedDisclosureContent>
    </>
  );
}
