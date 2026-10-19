"use client";

import { motion } from "motion/react";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { LuFolderOpen, LuUserSearch } from "react-icons/lu";
import { Logo } from "@/components/icons/logo";
import { RippleButton } from "@/components/ui/ripple";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { MOTION_EASE_OUT } from "@/lib/motion";

export type ProfilesEmptyKind = "onboarding" | "group" | "filtered";

interface EmptyAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

/** The logo with its ring drawn around it once. */
function DrawnLogo({ animate }: { animate: boolean }) {
  return (
    <div className="relative grid size-14 place-items-center">
      <motion.svg
        aria-hidden="true"
        viewBox="0 0 56 56"
        className="absolute inset-0 size-14 text-muted-foreground/40"
      >
        <motion.circle
          cx={28}
          cy={28}
          r={26}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          transform="rotate(-90 28 28)"
          initial={animate ? { pathLength: 0 } : false}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.7, ease: MOTION_EASE_OUT }}
        />
      </motion.svg>
      <motion.span
        className="grid place-items-center"
        initial={animate ? { opacity: 0.6, scale: 0.92 } : false}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.7, ease: MOTION_EASE_OUT }}
      >
        <Logo className="size-10 text-muted-foreground" />
      </motion.span>
    </div>
  );
}

function EmptyIcon({
  icon: Icon,
  animate,
}: {
  icon: React.ComponentType<{ className?: string }>;
  animate: boolean;
}) {
  return (
    <motion.div
      aria-hidden="true"
      className="grid size-12 place-items-center rounded-full bg-foreground/6"
      initial={animate ? { scale: 0.9 } : false}
      animate={{ scale: 1 }}
      transition={{ duration: 0.24, ease: MOTION_EASE_OUT }}
    >
      <Icon className="size-6 text-muted-foreground" />
    </motion.div>
  );
}

/**
 * What the profile table shows with no rows: the first-run invitation, an
 * empty group with the two ways to fill it, or a search that matched
 * nothing.
 */
export function ProfilesEmptyState({
  kind,
  onCreateProfile,
  onImportProfiles,
  onClearFilters,
  onCreateProfileInGroup,
  onMoveProfilesHere,
}: {
  kind: ProfilesEmptyKind;
  onCreateProfile?: () => void;
  onImportProfiles?: () => void;
  onClearFilters?: () => void;
  onCreateProfileInGroup?: () => void;
  onMoveProfilesHere?: () => void;
}) {
  const { t } = useTranslation();
  const animate = useMotionAllowed();

  const createHere = onCreateProfileInGroup ?? onCreateProfile;
  const content: {
    title: string;
    hint: string;
    actions: EmptyAction[];
  } =
    kind === "onboarding"
      ? {
          title: t("profiles.table.emptyTitle"),
          hint: t("profiles.table.emptyHint"),
          actions: [
            ...(onCreateProfile
              ? [
                  {
                    label: t("profiles.table.emptyCreate"),
                    onClick: onCreateProfile,
                    primary: true,
                  },
                ]
              : []),
            ...(onImportProfiles
              ? [
                  {
                    label: t("profiles.table.emptyImport"),
                    onClick: onImportProfiles,
                  },
                ]
              : []),
          ],
        }
      : kind === "group"
        ? {
            title: t("profileTable.emptyGroupTitle"),
            hint: t("profileTable.emptyGroupHint"),
            actions: [
              ...(createHere
                ? [
                    {
                      label: t("profileTable.emptyGroupCreate"),
                      onClick: createHere,
                      primary: true,
                    },
                  ]
                : []),
              ...(onMoveProfilesHere
                ? [
                    {
                      label: t("profileTable.emptyGroupMove"),
                      onClick: onMoveProfilesHere,
                    },
                  ]
                : []),
            ],
          }
        : {
            title: t("profiles.table.emptyFilteredTitle"),
            hint: t("profiles.table.emptyFilteredHint"),
            actions: onClearFilters
              ? [{ label: t("tables.clearFilters"), onClick: onClearFilters }]
              : [],
          };

  return (
    <motion.div
      data-slot="profiles-empty-state"
      data-empty-kind={kind}
      className="flex flex-col items-center gap-3 text-center"
      initial={animate ? { opacity: 0.5, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: MOTION_EASE_OUT }}
    >
      {kind === "onboarding" ? (
        <DrawnLogo animate={animate} />
      ) : (
        <EmptyIcon
          icon={kind === "group" ? LuFolderOpen : LuUserSearch}
          animate={animate}
        />
      )}
      <div>
        <p className="text-sm font-medium text-foreground">{content.title}</p>
        <p className="mt-1 max-w-sm text-xs text-pretty text-muted-foreground">
          {content.hint}
        </p>
      </div>
      {content.actions.length > 0 && (
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          {content.actions.map((action, index) => (
            <motion.span
              key={action.label}
              className="inline-flex"
              initial={animate ? { opacity: 0.5, y: 4 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.2,
                delay: animate ? 0.08 + index * 0.04 : 0,
                ease: MOTION_EASE_OUT,
              }}
            >
              <RippleButton
                size="sm"
                variant={action.primary ? "default" : "soft"}
                onClick={action.onClick}
              >
                {action.label}
              </RippleButton>
            </motion.span>
          ))}
        </div>
      )}
    </motion.div>
  );
}
