import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

/** The first "Profile N" that no profile has yet, compared without case. */
export function nextProfileName(
  taken: readonly string[],
  format: (n: number) => string,
): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  for (let n = 1; ; n += 1) {
    const name = format(n);
    if (!used.has(name.toLowerCase())) return name;
  }
}

/**
 * Create pressed before the browser is on disk. The press is kept: the
 * download starts if none runs, and when the browser is there and its terms
 * are accepted, `create` runs. A download that stops without a browser drops
 * the press.
 */
export function useCreateWhenBrowserReady({
  ready,
  downloading,
  startDownload,
  recheck,
  create,
}: {
  /** A browser version is on disk and no download runs. */
  ready: boolean;
  downloading: boolean;
  startDownload: () => void;
  /** Reads the downloaded versions again; resolves to how many there are. */
  recheck: () => Promise<number>;
  create: () => void;
}) {
  const [waiting, setWaiting] = useState(false);
  const createRef = useRef(create);
  createRef.current = create;
  const recheckRef = useRef(recheck);
  recheckRef.current = recheck;

  const request = useCallback(() => {
    setWaiting(true);
    if (!downloading) startDownload();
  }, [downloading, startDownload]);
  const cancel = useCallback(() => setWaiting(false), []);

  const wasDownloading = useRef(downloading);
  useEffect(() => {
    const stopped = wasDownloading.current && !downloading;
    wasDownloading.current = downloading;
    if (!waiting || !stopped || ready) return;
    let alive = true;
    void recheckRef
      .current()
      .then((count) => {
        if (alive && count === 0) setWaiting(false);
      })
      .catch(() => {
        if (alive) setWaiting(false);
      });
    return () => {
      alive = false;
    };
  }, [waiting, downloading, ready]);

  useEffect(() => {
    if (!waiting || !ready) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    const go = () => {
      if (!alive) return;
      alive = false;
      setWaiting(false);
      createRef.current();
    };
    void listen("wayfern-terms-accepted", go).then((stop) => {
      if (alive) unlisten = stop;
      else stop();
    });
    void invoke<boolean>("check_wayfern_terms_accepted")
      .then((accepted) => {
        if (accepted) go();
      })
      .catch((error: unknown) => {
        console.error("Failed to check the Wayfern terms:", error);
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [waiting, ready]);

  return { waiting, request, cancel };
}
