"use client";

import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * An icon button in the solve toolbar that opens a panel below it — the overflow
 * menu and the help text. A disclosure rather than an ARIA menu: the overflow
 * panel holds the piece-count `<select>` next to its buttons, which `role="menu"`
 * does not allow, and plain Tab order already walks through it.
 *
 * The panel stays mounted and is only `hidden` while closed. Nothing in it loses
 * its state that way, and the controls keep existing for the server render and
 * the tests; `hidden` still takes them out of the tab order and the a11y tree.
 *
 * Escape closes it and returns focus to the trigger; a pointer press outside
 * closes it without moving focus, and so does focus moving on to something
 * outside it — tabbing from the help to the menu button would otherwise leave
 * both panels open on top of each other. Passing `open` makes it controlled, for
 * a caller whose panel entries have to close it (and then focus `triggerRef`
 * itself where that is wanted); `onOpenChange` is then required, or the trigger
 * could never change it.
 */
export default function ToolbarPopover({
  icon,
  label,
  className = "",
  open: controlledOpen,
  onOpenChange,
  triggerRef,
  children,
}: {
  icon: ReactNode;
  /** Accessible name and tooltip of the trigger. */
  label: string;
  className?: string;
  /** For a caller that has to focus the trigger itself, e.g. after a dialog. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
} & (
  | { open?: undefined; onOpenChange?: (open: boolean) => void }
  | { open: boolean; onOpenChange: (open: boolean) => void }
)) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const ownRef = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? ownRef;
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  function setOpen(next: boolean) {
    if (controlledOpen === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  }

  const onPressOutside = useEffectEvent((e: PointerEvent) => {
    if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
  });

  const onEscape = useEffectEvent((e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    setOpen(false);
    trigger.current?.focus();
  });

  // On the document rather than the wrapper: focus is not necessarily inside —
  // a press on the panel's padding leaves it on <body>.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      onPressOutside(e);
    }
    function onKeyDown(e: KeyboardEvent) {
      onEscape(e);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={wrapRef}
      className={`toolbar-popover ${className}`}
      onBlur={(e) => {
        // Only a move to another element: a press on the panel's padding blurs to
        // <body> (no relatedTarget), and that must leave the panel open.
        const next = e.relatedTarget;
        if (open && next instanceof Node && !e.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">{icon}</span>
      </button>
      <div id={panelId} className="toolbar-popover-panel" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
