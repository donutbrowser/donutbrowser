"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_INTERFACE_ZOOM } from "@/lib/interface-zoom";

/**
 * The app's interface size in percent, and a setter. The backend applies it
 * to the window and tells every listener, so the setting and the shortcuts
 * stay in step.
 */
export function useInterfaceZoom() {
  const [zoom, setZoomState] = useState(DEFAULT_INTERFACE_ZOOM);

  useEffect(() => {
    let active = true;
    invoke<{ interface_zoom?: number }>("get_app_settings")
      .then((settings) => {
        if (active && settings.interface_zoom) {
          setZoomState(settings.interface_zoom);
        }
      })
      .catch(() => {});
    const unlisten = listen<number>("interface-zoom-changed", (event) => {
      if (active) setZoomState(event.payload);
    });
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  const setZoom = useCallback(async (next: number) => {
    const applied = await invoke<number>("set_interface_zoom", { zoom: next });
    setZoomState(applied);
  }, []);

  return { zoom, setZoom };
}
