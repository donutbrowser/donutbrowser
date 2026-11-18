import "@/i18n";
import "@/styles/fonts.css";
import "@/styles/globals.css";
import "flag-icons/css/flag-icons.min.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Page from "@/app/page";
import { ClientProviders } from "@/components/client-providers";
import { ErrorBoundary } from "@/components/error-boundary";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

// The outer boundary catches a failure of the providers themselves; the inner
// one keeps a page error inside the themed, translated shell.
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary fill>
      <ClientProviders>
        <ErrorBoundary fill>
          <Page />
        </ErrorBoundary>
      </ClientProviders>
    </ErrorBoundary>
  </StrictMode>,
);
