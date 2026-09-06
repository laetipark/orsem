import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export function WatchlistDialog({
  title,
  onClose,
  children,
  wide = false,
  mobileSheet = false,
  closeDisabled = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  mobileSheet?: boolean;
  closeDisabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    label = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const previous = document.activeElement;
    if (d.showModal) d.showModal();
    else d.setAttribute('open', '');
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`watch-dialog ${wide ? 'watch-dialog--wide' : ''} ${mobileSheet ? 'watch-dialog--mobile-sheet' : ''}`}
      aria-labelledby={label}
      onCancel={(e) => {
        e.preventDefault();
        if (!closeDisabled) onClose();
      }}
    >
      <header>
        <h2 id={label}>{title}</h2>
        <button
          type="button"
          className="watch-icon-button"
          aria-label="닫기"
          disabled={closeDisabled}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="watch-dialog__body">{children}</div>
    </dialog>
  );
}
export function moveEntry<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
  const next = [...items];
  next.splice(to, 0, next.splice(from, 1)[0]!);
  return next;
}
