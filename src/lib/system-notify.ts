import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export interface SystemNotification {
  title: string;
  body?: string;
}

interface NotifySettings {
  system_notifications?: boolean;
}

const MAX_BODY_CHARS = 200;

let permission: Promise<boolean> | null = null;

/** Asks the OS once per session; a refusal is kept until the next launch. */
function ensurePermission(): Promise<boolean> {
  permission ??= (async () => {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  })().catch(() => false);
  return permission;
}

async function windowInFront(): Promise<boolean> {
  try {
    const window = getCurrentWindow();
    const [visible, focused, minimized] = await Promise.all([
      window.isVisible(),
      window.isFocused(),
      window.isMinimized(),
    ]);
    return visible && focused && !minimized;
  } catch {
    return typeof document !== "undefined" && document.hasFocus();
  }
}

async function enabled(): Promise<boolean> {
  try {
    const settings = await invoke<NotifySettings>("get_app_settings");
    return settings.system_notifications !== false;
  } catch {
    return false;
  }
}

/**
 * A notification from the OS, for an event the person would otherwise miss.
 * Does nothing when the setting is off or the window is in front, where the
 * app shows the event itself.
 */
export async function notifySystem(opts: SystemNotification): Promise<void> {
  if (await windowInFront()) return;
  if (!(await enabled())) return;
  if (!(await ensurePermission())) return;
  const body =
    opts.body && opts.body.length > MAX_BODY_CHARS
      ? `${opts.body.slice(0, MAX_BODY_CHARS - 1)}…`
      : opts.body;
  try {
    sendNotification(body ? { title: opts.title, body } : opts.title);
  } catch (error) {
    console.warn("System notification failed:", error);
  }
}
