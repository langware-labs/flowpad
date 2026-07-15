import { cn } from '@src/lib/utils';
import { useIdleAutoClose } from '@src/hooks/use-idle-auto-close';
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEventHandler, type ReactNode } from 'react';

/** Rail-anchored offset (matches RAIL_WIDTH_CLASS = w-[50px]). The slider floats
 *  against the rail's right edge. */
const RAIL_OFFSET = 50;

/**
 * LeftSlider — a generic left-edge slide-in overlay, anchored at the rail's
 * right edge. A transient, non-modal flyout: it floats over content (the rail
 * stays interactive) and dismisses on outside pointer-down, Escape, and — unless
 * a hover-driven owner opts out with `idleMs={null}` — 5s of idle (see
 * `useIdleAutoClose`). Reusable layout element — the `headerRight` slot is the
 * canonical home for a scope filter, so any "scoped menu" drops in.
 *
 * The toggle control that opens this must carry `data-left-slider-ignore` so a
 * click on it doesn't register as an outside-dismiss (which would fight the
 * toggle).
 */
export function LeftSlider({
  open,
  onOpenChange,
  title,
  headerRight,
  width = 320,
  idleMs,
  onPointerEnter,
  onPointerLeave,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  headerRight?: ReactNode;
  width?: number;
  /** `null` opts out of the idle auto-close — for a hover-driven slider that
   *  owns its own dismissal via pointer-leave. See useIdleAutoClose. */
  idleMs?: number | null;
  /** Panel hover, so a hover-driven owner can keep the slider open while the
   *  pointer is inside it and close on leave. Spread the SAME `hoverProps` here
   *  as on the control that opens it — one shared intent, so crossing from one
   *  to the other never closes. */
  onPointerEnter?: PointerEventHandler;
  onPointerLeave?: PointerEventHandler;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Two-phase mount so the open/close slide animates: mount first, then flip
  // `shown` on the next frame; on close, unmount after the transition ends.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(t);
  }, [open]);

  // Escape + outside pointer-down dismiss (only while open).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest('[data-left-slider-ignore]')) return;
      onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, onOpenChange]);

  useIdleAutoClose(open, () => onOpenChange(false), idleMs);

  if (!mounted) return null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={typeof title === 'string' ? title : undefined}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{ left: RAIL_OFFSET, width }}
      className={cn(
        'fixed inset-y-0 z-40 flex flex-col border-r border-border bg-background shadow-lg',
        'transition-transform duration-200 ease-in-out',
        shown ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {title != null && <div className="text-sm font-semibold text-foreground">{title}</div>}
        <div className="ml-auto flex items-center gap-1">
          {headerRight}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
    </div>
  );
}
