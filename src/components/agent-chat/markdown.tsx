"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isExternalLink } from "@/lib/agent-chat";
import { cn } from "@/lib/utils";

/**
 * The engine's answer as formatted text. Raw HTML is dropped, images show as
 * their links, and a link opens in the system browser, never in the app.
 */
const COMPONENTS: Components = {
  a: ({ href, children }) =>
    isExternalLink(href) ? (
      <a
        href={href}
        title={href}
        className="font-medium text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
        onClick={(event) => {
          event.preventDefault();
          void openUrl(href).catch((error: unknown) => {
            console.warn("Failed to open a link:", error);
          });
        }}
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt, src }) =>
    typeof src === "string" && isExternalLink(src) ? (
      <a
        href={src}
        className="text-primary underline underline-offset-2"
        onClick={(event) => {
          event.preventDefault();
          void openUrl(src).catch((error: unknown) => {
            console.warn("Failed to open a link:", error);
          });
        }}
      >
        {alt || src}
      </a>
    ) : null,
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground">
      {children}
    </ol>
  ),
  h1: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-base font-semibold first:mt-0">
      {children}
    </h3>
  ),
  h2: ({ children }) => (
    <h4 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h4>
  ),
  h3: ({ children }) => (
    <h5 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h5>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 rounded-lg bg-foreground/5 px-3 py-1.5 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <div className="my-3 h-2" aria-hidden="true" />,
  pre: ({ children }) => (
    <pre
      data-slot="chat-code"
      className="my-2 overflow-x-auto rounded-xl bg-foreground/5 px-3 py-2.5 font-mono text-xs leading-relaxed [&>code]:bg-transparent [&>code]:p-0"
    >
      {children}
    </pre>
  ),
  code: ({ className, children }) => (
    <code
      className={cn(
        "rounded-md bg-foreground/8 px-1 py-px font-mono text-[0.85em]",
        className,
      )}
    >
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table
        data-slot="chat-table"
        className="w-full border-separate border-spacing-0 text-xs"
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children, style }) => (
    <th
      style={style}
      className="bg-foreground/5 px-2.5 py-1.5 text-left font-medium text-muted-foreground first:rounded-l-lg last:rounded-r-lg"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="px-2.5 py-1.5 tabular-nums">
      {children}
    </td>
  ),
};

export function ChatMarkdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div
      data-slot="chat-markdown"
      className={cn("text-sm leading-6 break-words", className)}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={COMPONENTS}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
