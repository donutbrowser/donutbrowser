"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

/**
 * Whether this device stores a sync encryption password. The password seals
 * the synced settings of every profile, so a remote host cannot open one.
 * False until the first read answers.
 */
export function useSyncPasswordSet(): boolean {
  const [set, setSet] = useState(false);

  useEffect(() => {
    let disposed = false;
    const read = () => {
      void invoke<boolean>("check_has_e2e_password")
        .then((stored) => {
          if (!disposed) setSet(stored);
        })
        .catch((error: unknown) => {
          console.error("Failed to read the sync password state:", error);
        });
    };
    read();
    const unlisten = listen("sync-password-changed", read);
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);

  return set;
}
