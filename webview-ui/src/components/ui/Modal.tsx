import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';

import { useEscapeLayer } from '../../hooks/useEscapeLayer.js';
import { Button } from './Button.js';
import { isTextEntry } from './focusRules.js';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** z-index for backdrop (modal gets +1). Default 49 */
  zIndex?: number;
  className?: string;
}

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex], [contenteditable="true"], [contenteditable=""]';

/** The panel's keyboard-reachable controls, in order (the header's close
 *  button included). */
function focusables(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.hasAttribute('disabled') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      el.getClientRects().length > 0,
  );
}

/** Where focus goes when the dialog opens: its first control below the
 *  header, unless that is a text field (focusing one summons a phone's
 *  keyboard), in which case the dialog itself. */
function initialFocus(panel: HTMLElement, header: HTMLElement | null): HTMLElement {
  const first = focusables(panel).find((el) => !header?.contains(el));
  if (!first) return panel;
  return isTextEntry(first.tagName, first.getAttribute('type'), first.isContentEditable)
    ? panel
    : first;
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  zIndex = 50,
  className = '',
}: ModalProps) {
  // Escape closes the topmost open surface (escapeStack.ts).
  useEscapeLayer(isOpen, onClose, { z: zIndex });
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog when it opens (unless a control inside took it
  // already, e.g. autoFocus) and back to what had it when it closes.
  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (panel && !panel.contains(document.activeElement)) {
      initialFocus(panel, headerRef.current).focus({ preventScroll: true });
    }
    return () => {
      const active = document.activeElement;
      const lost = !active || active === document.body || (panel?.contains(active) ?? false);
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [isOpen]);

  // Tab and Shift+Tab stay inside the dialog (aria-modal: the page behind it
  // is out of reach).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = focusables(panelRef.current);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50" style={{ zIndex }} onClick={onClose} />
      {/* Sizing wrapper: a full-viewport flex box (inset-0, no viewport
          units — dvw/dvh support varies across iOS) whose padding is the
          modal's screen margin. The panel can never exceed it: max-w/h-full
          caps it, min-width yields via min() (min-width beats max-width in
          CSS, so an unconditional minimum would overflow narrow phones), and
          overflow scrolls. Clicks on the margin fall through to the
          backdrop. */}
      <div
        className="fixed inset-0 flex items-center justify-center p-8 pointer-events-none"
        style={{ zIndex: zIndex + 1 }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className={`pointer-events-auto pixel-dialog p-4 min-w-[min(320px,100%)] max-w-full max-h-full overflow-y-auto overflow-x-hidden outline-none ${className}`}
        >
          {/* Sticky so the close button stays reachable while long content
              (changelog, settings) scrolls under it. */}
          <div
            ref={headerRef}
            className="sticky top-0 z-10 bg-bg flex items-center justify-between py-4 px-10 border-b border-border mb-4"
          >
            <span id={titleId} className="text-accent-bright text-2xl">
              {title}
            </span>
            <Button variant="ghost" size="icon" onClick={onClose}>
              x
            </Button>
          </div>
          {children}
        </div>
      </div>
    </>
  );
}
