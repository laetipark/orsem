import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp, X } from 'lucide-react';
import './help-popover.css';

const focusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

/** A touch-friendly, keyboard-accessible explanation without persistent page copy. */
export function HelpPopover({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 12, left: 12, width: 320 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const trigger = triggerRef.current;
    if (!dialog || !trigger) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    closeRef.current?.focus();

    const place = () => {
      const anchor = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const width = Math.min(320, viewportWidth - 24);
      const left = Math.max(
        viewportLeft + 12,
        Math.min(anchor.right - width, viewportLeft + viewportWidth - width - 12),
      );
      const height = Math.min(dialog.getBoundingClientRect().height, viewportHeight - 24);
      const below = anchor.bottom + 6;
      const top = Math.max(
        viewportTop + 12,
        Math.min(
          below + height <= viewportTop + viewportHeight - 12 ? below : anchor.top - height - 6,
          viewportTop + viewportHeight - height - 12,
        ),
      );
      setPosition({ top, left, width });
    };
    place();
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    resizeObserver?.observe(dialog);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);

    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !dialog.contains(event.target) &&
        !trigger.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      } else if (event.key === 'Tab') {
        // Native dialogs trap focus; this also supports browsers without showModal.
        const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keydown);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keydown);
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      if (trigger.isConnected) trigger.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="help-popover__trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <CircleHelp size={18} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <dialog
            ref={dialogRef}
            id={id}
            className="help-popover__dialog"
            aria-labelledby={`${id}-title`}
            aria-modal="true"
            style={position}
            onCancel={(event) => {
              event.preventDefault();
              setOpen(false);
            }}
            onClick={(event) => {
              // Backdrop clicks target the dialog, but lie outside its rectangle.
              if (event.target !== event.currentTarget) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              if (
                event.clientX < bounds.left ||
                event.clientX > bounds.right ||
                event.clientY < bounds.top ||
                event.clientY > bounds.bottom
              ) {
                setOpen(false);
              }
            }}
          >
            <header className="help-popover__header">
              <strong id={`${id}-title`}>{label}</strong>
              <button
                ref={closeRef}
                type="button"
                className="help-popover__close"
                aria-label="도움말 닫기"
                onClick={() => setOpen(false)}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </header>
            <div className="help-popover__content">{children}</div>
          </dialog>,
          document.body,
        )}
    </>
  );
}
