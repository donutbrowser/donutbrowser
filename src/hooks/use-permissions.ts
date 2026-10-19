import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { getCurrentOS, type OperatingSystem } from "@/lib/platform";

// Platform-specific imports
let macOSPermissions:
  | typeof import("tauri-plugin-macos-permissions-api")
  | null = null;

// Dynamically import macOS permissions only when needed
const loadMacOSPermissions = async () => {
  if (macOSPermissions) return macOSPermissions;

  try {
    macOSPermissions = await import("tauri-plugin-macos-permissions-api");
    return macOSPermissions;
  } catch (error) {
    console.warn("Failed to load macOS permissions API:", error);
    return null;
  }
};

export type PermissionType = "microphone" | "camera";

interface UsePermissionsReturn {
  requestPermission: (type: PermissionType) => Promise<boolean>;
  isMicrophoneAccessGranted: boolean;
  isCameraAccessGranted: boolean;
  isInitialized: boolean;
  currentOS: OperatingSystem | null;
  requiresSystemPermissions: boolean;
}

interface PermissionState {
  microphone: boolean;
  camera: boolean;
  initialized: boolean;
}

/** While a permission UI is open, how often it reads the macOS state. */
const OPEN_POLL_MS = 5000;

const INITIAL_STATE: PermissionState = {
  microphone: false,
  camera: false,
  initialized: false,
};

// One state for every instance: what one instance reads, all of them show.
let shared = INITIAL_STATE;
const subscribers = new Set<() => void>();
let reading: Promise<void> | null = null;
// Bumped by a request: a read that started before it holds older values.
let generation = 0;

function publish(next: Partial<PermissionState>) {
  const merged = { ...shared, ...next };
  if (
    merged.microphone === shared.microphone &&
    merged.camera === shared.camera &&
    merged.initialized === shared.initialized
  ) {
    return;
  }
  shared = merged;
  for (const notify of subscribers) notify();
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

const snapshot = () => shared;
const serverSnapshot = () => INITIAL_STATE;

/** Reads both permissions; concurrent calls share one read. */
function readPermissions(os: OperatingSystem): Promise<void> {
  if (os !== "macos") {
    // Windows/Linux - assume permissions are granted
    publish({ microphone: true, camera: true, initialized: true });
    return Promise.resolve();
  }
  if (reading) return reading;
  const startedAt = generation;
  reading = (async () => {
    try {
      const permissions = await loadMacOSPermissions();
      if (permissions) {
        const [microphone, camera] = await Promise.all([
          permissions.checkMicrophonePermission(),
          permissions.checkCameraPermission(),
        ]);
        if (startedAt === generation) publish({ microphone, camera });
      }
    } catch (error) {
      console.error("Failed to check permissions on macOS:", error);
    } finally {
      publish({ initialized: true });
      reading = null;
    }
  })();
  return reading;
}

/**
 * macOS camera and microphone access. Called without an argument (the app
 * shell), it reads the state once and again whenever the window comes back
 * to the front, which is where a change made in System Settings shows up.
 * A permission UI passes whether it is open: while open it also reads the
 * state every few seconds, to catch a late grant; while closed it reads
 * nothing.
 */
export function usePermissions(open?: boolean): UsePermissionsReturn {
  const state = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const [currentOS, setCurrentOS] = useState<OperatingSystem | null>(null);
  const active = open ?? true;
  const poll = open === true;

  // Request permission
  const requestPermission = useCallback(
    async (type: PermissionType): Promise<boolean> => {
      // Non-macOS platforms do not require this permission gate.
      if ((currentOS ?? getCurrentOS()) !== "macos") return true;

      // macOS - use the permissions API
      try {
        const permissions = await loadMacOSPermissions();
        if (!permissions) return false;

        if (type === "microphone") {
          await permissions.requestMicrophonePermission();
        } else {
          await permissions.requestCameraPermission();
        }

        // Read once immediately. An open permission UI keeps watching for
        // delayed TCC propagation without holding this request (and any next
        // system prompt) open for several extra seconds.
        const granted =
          type === "microphone"
            ? await permissions.checkMicrophonePermission()
            : await permissions.checkCameraPermission();
        generation += 1;
        publish(
          type === "microphone" ? { microphone: granted } : { camera: granted },
        );
        return granted;
      } catch (error) {
        console.error(`Failed to request ${type} permission on macOS:`, error);
        return false;
      }
    },
    [currentOS],
  );

  useEffect(() => {
    setCurrentOS(getCurrentOS());
  }, []);

  useEffect(() => {
    if (!currentOS || !active) return;
    void readPermissions(currentOS);

    // Only macOS permissions can change at runtime.
    if (currentOS !== "macos") return;

    const readIfVisible = () => {
      if (document.visibilityState === "visible") {
        void readPermissions(currentOS);
      }
    };
    window.addEventListener("focus", readIfVisible);
    document.addEventListener("visibilitychange", readIfVisible);
    const interval = poll ? setInterval(readIfVisible, OPEN_POLL_MS) : null;

    return () => {
      window.removeEventListener("focus", readIfVisible);
      document.removeEventListener("visibilitychange", readIfVisible);
      if (interval !== null) clearInterval(interval);
    };
  }, [active, poll, currentOS]);

  return {
    requestPermission,
    isMicrophoneAccessGranted: state.microphone,
    isCameraAccessGranted: state.camera,
    // Not before the platform is known: on the first render `currentOS` is
    // still null, and a caller would take macOS for a platform without the
    // permission gate.
    isInitialized: currentOS !== null && state.initialized,
    currentOS,
    requiresSystemPermissions: currentOS === "macos",
  };
}
