// Lightweight module-level flag for whether the first-run onboarding is in
// progress. The welcome dialog shows its own browser-setup progress, so the
// global browser-download toasts (from use-browser-download) are suppressed
// while this is true to avoid a competing toast during onboarding.
let active = false;

export function setOnboardingActive(value: boolean): void {
  active = value;
}

export function isOnboardingActive(): boolean {
  return active;
}
