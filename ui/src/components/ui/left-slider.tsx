import { cn } from '@src/lib/utils';
import { useIdleAutoClose } from '@src/hooks/use-idle-auto-close';
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEventHandler, type ReactNode } from 'react';

/** Rail-anchored offset (matches RAIL_WIDTH_CLASS = w-[50px]). The slider floats
 *  against the rail's right edge. */
const RAIL_OFFSET = 50;
/** Where the menu sits when the owner passes no anchor. */
const ANCHOR_FALLBACK_TOP = 8;
/** Cap before the body scrolls. */
const MAX_HEIGHT = '60vh';
/** Floor so the header (title + action icons) never wraps. */
const MIN_WIDTH = 224;
/** Breathing room at the viewport's bottom edge. */
const VIEWPORT_GUTTER = 8;

/**
 * LeftSlider — a generic left-edge slide-in MENU, anchored beside the rail
 * control that opens it. A transient, non-modal flyout: it floats over content
 * (the rail stays interactive) and dismisses on outside pointer-down, Escape,
 * and — unless a hover-driven owner opts out with `idleMs={null}` — 5s of idle
 * (see `useIdleAutoClose`). Reusable layout element — the `headerRight` slot is
 * the canonical home for a scope filter, so any "scoped menu" drops in.
 *
 * Sized to its CONTENT, capped by `maxHeight`, not stretched to the viewport.
 * That is the flyout-menu pattern rather than the navigation-drawer one, and the
 * distinction is behavioural, not cosmetic: a full-height surface says "I am
 * staying", which contradicts a menu that dismisses when you move the pointer
 * away. Hugging the content also means a short menu barely overlaps the rail
 * even mid-animation.
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
  anchorTop = ANCHOR_FALLBACK_TOP,
  idleMs,
  onPointerEnter,
  onPointerLeave,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  headerRight?: ReactNode;
  /** Maximum width. The menu sizes to its content and stops here. */
  width?: number;
  /** Viewport y the menu's top edge aligns to — pass the trigger's own top so
   *  the menu reads as belonging to it. */
  anchorTop?: number;
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
      style={{
        left: RAIL_OFFSET,
        top: anchorTop,
        // Size to content, not a fixed slab: short bookmark names left most of a
        // 320px panel empty. Clamped between a min that fits the header and
        // `width` as the cap so a long name/path can't run away.
        width: 'max-content',
        minWidth: MIN_WIDTH,
        maxWidth: width,
        // Clamp to what's left below the anchor, or a menu opened from a low
        // control would run off the bottom of the viewport.
        maxHeight: `min(${MAX_HEIGHT}, calc(100vh - ${anchorTop}px - ${VIEWPORT_GUTTER}px))`,
      }}
      className={cn(
        'fixed z-40 flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg',
        'transition-transform duration-200 ease-in-out',
        // `-translate-x-full` parks the panel at left = RAIL_OFFSET - width, so
        // while it is animating in or out it sits directly ON TOP of the rail
        // that opens it. It must not hit-test there: a hover-driven owner would
        // otherwise receive pointerenter from its own off-screen panel while the
        // pointer is really on a rail icon, reopen, slide away, get pointerleave,
        // close, slide back under the pointer — an oscillation that never
        // settles. Only a shown panel takes the pointer.
        shown ? 'translate-x-0' : '-translate-x-full pointer-events-none',
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
