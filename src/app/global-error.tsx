"use client";

import "@/i18n";
import "@/styles/globals.css";
import { useEffect } from "react";
import { ErrorScreen } from "@/components/error-boundary";
import { logRenderError } from "@/lib/logger";

/** The root layout itself failed: the providers are gone, so it stands alone. */
export default function GlobalError({ error }: { error: Error }) {
  useEffect(() => {
    logRenderError(error);
  }, [error]);
  return (
    <html lang="en" className="dark">
      <body className="overflow-hidden bg-background antialiased">
        <ErrorScreen error={error} fill />
      </body>
    </html>
  );
}
