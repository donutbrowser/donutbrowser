"use client";

import { type HTMLMotionProps, motion } from "motion/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { LuX } from "react-icons/lu";

import { FOCUS_RING } from "@/components/ui/focus-ring";
import { useControlledState } from "@/hooks/use-controlled-state";
import { useMotionAllowed } from "@/hooks/use-motion-allowed";
import { getStrictContext } from "@/lib/get-strict-context";
import {
  MOTION_DURATION,
  MOTION_EASE_IN,
  MOTION_EASE_OUT,
  originToward,
} from "@/lib/motion";
import { cn } from "@/lib/utils";
import { WindowDragArea } from "../window-drag-area";

/**
 * A closed modal stays mounted this long for its exit, then unmounts on a
 * timer. No animation callback decides it, so a paused webview cannot keep a
 * closed dialog on screen.
 */
const DIALOG_EXIT_FALLBACK_MS = 150;
const DIALOG_EXIT_TRANSITION = {
  duration: MOTION_DURATION.fast,
  ease: MOTION_EASE_IN,
};

type DialogContextType = {
  isOpen: boolean;
  /** Closed, still mounted while the exit plays. */
  exiting: boolean;
  setIsOpen: DialogProps["onOpenChange"];
  subPage: boolean;
  container: HTMLElement | null | undefined;
  motionEnabled: boolean;
  motionAllowed: boolean;
};

const [DialogProvider, useDialog] =
  getStrictContext<DialogContextType>("DialogContext");

type DialogProps = React.ComponentProps<typeof DialogPrimitive.Root> & {
  /** Render in a portal container as an in-flow sub-page instead of a centered modal. */
  subPage?: boolean;
  /** Portal container target. Required when subPage=true; ignored otherwise. */
  container?: HTMLElement | null;
  motionEnabled?: boolean;
};

function Dialog({
  subPage,
  container,
  motionEnabled = true,
  children,
  ...props
}: DialogProps) {
  const [isOpen, setIsOpen] = useControlledState({
    value: props?.open,
    defaultValue: props?.defaultOpen,
    onChange: props?.onOpenChange,
  });
  const motionAllowed = useMotionAllowed();
  const animateExit = motionEnabled && motionAllowed && !subPage;
  const [exiting, setExiting] = React.useState(false);
  const [wasOpen, setWasOpen] = React.useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    setExiting(!isOpen && animateExit);
  }
  React.useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(
      () => setExiting(false),
      DIALOG_EXIT_FALLBACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [exiting]);
  // While the exit plays the dialog is already closed: a second close request
  // (an outside click, Escape) must not reach the owner again.
  const requestOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open && !isOpen) return;
      setIsOpen(open);
    },
    [isOpen, setIsOpen],
  );

  return (
    <DialogProvider
      value={{
        isOpen,
        exiting,
        setIsOpen,
        subPage: !!subPage,
        container: container ?? undefined,
        motionEnabled,
        motionAllowed,
      }}
    >
      {/* In sub-page mode the Dialog isn't a modal — it's an in-flow page.
          Forcing `modal={false}` prevents Radix from locking pointer-events
          and aria-hiding everything outside the dialog. Children are passed
          explicitly (not via spread) so React doesn't have to guess where
          the JSX subtree should mount. */}
      <DialogPrimitive.Root
        data-slot="dialog"
        {...props}
        modal={subPage ? false : props.modal}
        onOpenChange={requestOpenChange}
      >
        {children}
      </DialogPrimitive.Root>
    </DialogProvider>
  );
}

type DialogTriggerProps = React.ComponentProps<typeof DialogPrimitive.Trigger>;

function DialogTrigger(props: DialogTriggerProps) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

type DialogPortalProps = Omit<
  React.ComponentProps<typeof DialogPrimitive.Portal>,
  "forceMount"
>;

function DialogPortal({
  children,
  container: portalContainer,
  ...props
}: DialogPortalProps) {
  const { isOpen, exiting, container } = useDialog();

  if (!isOpen && !exiting) return null;

  return (
    <DialogPrimitive.Portal
      data-slot="dialog-portal"
      forceMount
      container={container ?? portalContainer}
      {...props}
    >
      {children}
    </DialogPrimitive.Portal>
  );
}

type DialogOverlayProps = Omit<
  React.ComponentProps<typeof DialogPrimitive.Overlay>,
  "forceMount" | "asChild"
> &
  HTMLMotionProps<"div">;

function DialogOverlay({ className, ...props }: DialogOverlayProps) {
  const { exiting, motionEnabled, motionAllowed } = useDialog();
  const fade = motionEnabled && motionAllowed;
  return (
    <DialogPrimitive.Overlay data-slot="dialog-overlay" asChild forceMount>
      <motion.div
        key="dialog-overlay"
        // Decorative: the dimmed backdrop may fade in from nothing.
        initial={fade ? { opacity: 0 } : false}
        animate={{ opacity: exiting ? 0 : 1 }}
        transition={
          fade
            ? exiting
              ? DIALOG_EXIT_TRANSITION
              : { duration: MOTION_DURATION.fast, ease: MOTION_EASE_OUT }
            : { duration: 0 }
        }
        className={cn(
          "fixed inset-0 z-9999 bg-background/50",
          exiting && "pointer-events-none",
          className,
        )}
        {...props}
      >
        {/* Keep the OS title-bar zone draggable while a modal is open — the
            overlay otherwise covers the native drag region. `data-window-drag-area`
            stops Radix from treating a drag here as an outside-click dismiss. */}
        <div
          data-tauri-drag-region
          data-window-drag-area="true"
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-11"
        />
        <WindowDragArea />
      </motion.div>
    </DialogPrimitive.Overlay>
  );
}

type DialogContentProps = Omit<
  React.ComponentProps<typeof DialogPrimitive.Content>,
  "forceMount" | "asChild"
> &
  HTMLMotionProps<"div"> & {
    /**
     * Suppress the built-in top-right close X. Use when the dialog renders
     * its own header bar with a custom close control to avoid two X buttons
     * stacking near the corner.
     */
    hideClose?: boolean;
    /**
     * When false, the user cannot dismiss the dialog — Escape and outside
     * clicks are ignored and the close X is hidden. Use for steps the user
     * must complete to progress (e.g. required onboarding, a blocking
     * download). The dialog can still be closed programmatically via `open`.
     */
    dismissible?: boolean;
  };

function SubPageContent({
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const { isOpen } = useDialog();
  if (!isOpen) return null;
  // Inline styles deliberately override any className the caller passed
  // for the modal mode (max-w-*, max-h-*, my-*). tailwind-merge inside the
  // shared dialog wrappers turned out to be unreliable when both classnames
  // and !important variants competed — inline styles guarantee the layout.
  return (
    <div
      data-slot="sub-page"
      data-sub-page="true"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        flex: "1 1 0%",
        minHeight: 0,
        width: "100%",
        maxWidth: "none",
        height: "100%",
        maxHeight: "none",
        margin: 0,
        padding: 12,
        gap: 12,
        // The sub-page wrapper never scrolls itself — exactly one inner
        // element per page owns scrolling (full-width, so the wheel works
        // over side gutters too). "auto" here created a competing,
        // never-engaged scroll container.
        overflow: "hidden",
        background: "var(--background)",
        containerType: "inline-size",
      }}
    >
      {children}
    </div>
  );
}

/** The transform origin that points a dialog box at the focused control. */
function originFromFocus(content: HTMLElement): string {
  const opener = document.activeElement;
  const rect =
    opener instanceof HTMLElement &&
    opener !== document.body &&
    !content.contains(opener)
      ? opener.getBoundingClientRect()
      : null;
  // The layout box, without the entry scale: same center, unscaled size.
  const box = content.getBoundingClientRect();
  const width = content.offsetWidth;
  const height = content.offsetHeight;
  return originToward(rect, {
    x: box.left + box.width / 2 - width / 2,
    y: box.top + box.height / 2 - height / 2,
    width,
    height,
  });
}

function DialogContent({
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onPointerDownOutside,
  onInteractOutside,
  transition,
  hideClose,
  dismissible = true,
  ref,
  ...props
}: DialogContentProps) {
  const { t } = useTranslation();
  const { exiting, subPage, motionEnabled, motionAllowed } = useDialog();
  const animateEntry = motionEnabled && motionAllowed;
  // The dialog grows out of the control that opened it. The node attaches
  // before Radix moves focus into the dialog (a later effect), so the focused
  // element here is still that control.
  const setContentRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (node) node.style.transformOrigin = originFromFocus(node);
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  // The exit shows what the dialog showed while open, even when the owner
  // clears the data behind it as it closes.
  const shownChildren = React.useRef(children);
  if (!exiting) shownChildren.current = children;

  if (subPage) {
    return <SubPageContent>{children}</SubPageContent>;
  }

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay key="dialog-overlay" />
      <DialogPrimitive.Content
        key="dialog-content"
        asChild
        forceMount
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (!dismissible) event.preventDefault();
          onEscapeKeyDown?.(event);
        }}
        onPointerDownOutside={onPointerDownOutside}
        onInteractOutside={(event) => {
          if (!dismissible) {
            event.preventDefault();
            return;
          }
          const target = event.target as HTMLElement | null;
          if (target?.closest('[data-window-drag-area="true"]')) {
            event.preventDefault();
          }
          onInteractOutside?.(event);
        }}
      >
        <motion.div
          key="dialog-content"
          ref={setContentRef}
          data-slot="dialog-content"
          // Content is readable on the first frame, even in an occluded webview:
          // the entry only scales. Keyboard navigation skips the settle, and a
          // closed dialog unmounts on a timer whatever the exit does.
          initial={animateEntry ? { scale: 0.985 } : false}
          animate={
            exiting ? { scale: 0.985, opacity: 0 } : { scale: 1, opacity: 1 }
          }
          transition={
            exiting
              ? DIALOG_EXIT_TRANSITION
              : animateEntry
                ? (transition ?? {
                    duration: MOTION_DURATION.base,
                    ease: MOTION_EASE_OUT,
                  })
                : { duration: 0 }
          }
          className={cn(
            // w-[calc(100%-2rem)] (not w-full + max-w) keeps the 1rem window
            // gutter even when callers override max-w-*: tailwind-merge drops
            // a base max-w in favor of the caller's, but leaves width alone.
            "fixed top-[50%] left-[50%] z-10000 grid max-h-[calc(100vh-3rem)] w-[calc(100%-2rem)] max-w-lg -translate-[50%] gap-4 overflow-y-auto rounded-lg border bg-background p-6",
            exiting && "pointer-events-none",
            className,
          )}
          {...props}
        >
          {exiting ? shownChildren.current : children}
          {!hideClose && dismissible && (
            <DialogPrimitive.Close
              className={cn(
                "absolute top-4 right-4 cursor-pointer rounded-xs opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                FOCUS_RING,
              )}
            >
              <LuX />
              <span className="sr-only">{t("common.buttons.close")}</span>
            </DialogPrimitive.Close>
          )}
        </motion.div>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

type DialogCloseProps = React.ComponentProps<typeof DialogPrimitive.Close>;

function DialogClose(props: DialogCloseProps) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 pr-8 text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex shrink-0 flex-row flex-wrap justify-end gap-2",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
