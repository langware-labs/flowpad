import { cn } from '@src/lib/utils';
import { useIdleAutoClose } from '@src/hooks/use-idle-auto-close';
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEventHandler, type ReactNode } from 'react';

/** Where the menu sits when the owner passes no anchor. */
const ANCHOR_FALLBACK_TOP = 8;
/** Cap before the body scrolls. */
const MAX_HEIGHT = '60vh';
/** Floor so the header (title + action icons) never wraps. */
const MIN_WIDTH = 224;
/** Breathing room at the viewport's bottom edge. */
const VIEWPORT_GUTTER = 8;

/**
 * The gap an owner must pass as `anchorEnd` to line a menu's inline-end edge up
 * with its trigger's: the distance from the VIEWPORT's inline-end edge to the
 * trigger's inline-end edge.
 *
 * Physical `right`/`left` swap roles between the two directions, so measuring
 * with the LTR formula in an RTL locale anchors the panel against the edge it is
 * furthest from and it renders off-window. Callers pass `dir` (from
 * `useLocaleInfo().dir`) rather than reading `document.documentElement.dir` here,
 * so the value stays reactive to a locale switch and testable without touching
 * the document.
 *
 * Clamped at 0 so a trigger scrolled past the viewport edge parks the menu at
 * that edge instead of pushing it out of view.
 */
export function viewportInlineEndGap(rect: DOMRect, dir: 'ltr' | 'rtl'): number {
  return Math.max(0, dir === 'rtl' ? rect.left : window.innerWidth - rect.right);
}

/**
 * AnchoredMenu — a slide-in MENU whose INLINE-END edge is pinned under the
 * control that opens it, growing toward inline-start. A transient, non-modal
 * flyout: it floats over content (the trigger stays interactive) and dismisses
 * on outside pointer-down, Escape, and — unless a hover-driven owner opts out
 * with `idleMs={null}` — 5s of idle (see `useIdleAutoClose`). Reusable layout
 * element — the `headerRight` slot is the canonical home for a scope filter, so
 * any "scoped menu" drops in.
 *
 * It used to be `LeftSlider`, pinned beside the rail and growing rightward. That
 * mode went with the rail's bookmarks icon; keeping a second branch nothing
 * selects would have left a `RAIL_OFFSET` and a z-order rationale describing a
 * relationship that no longer exists.
 *
 * Sized to its CONTENT, capped by `maxHeight`, not stretched to the viewport.
 * That is the flyout-menu pattern rather than the navigation-drawer one, and the
 * distinction is behavioural, not cosmetic: a full-height surface says "I am
 * staying", which contradicts a menu that dismisses when you move the pointer
 * away. Hugging the content also means a short menu barely overlaps the rail
 * even mid-animation.
 *
 * The toggle control that opens this must carry `data-anchored-menu-ignore` so a
 * click on it doesn't register as an outside-dismiss (which would fight the
 * toggle).
 */
export function AnchoredMenu({
  open,
  onOpenChange,
  title,
  headerRight,
  width = 320,
  anchorTop = ANCHOR_FALLBACK_TOP,
  anchorEnd = VIEWPORT_GUTTER,
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
  /** Distance from the VIEWPORT's INLINE-END edge to the menu's inline-end edge,
   *  so the two line up. Logical, not physical: the owner measures
   *  `window.innerWidth - triggerRect.right` under LTR but `triggerRect.left`
   *  under RTL (see `viewportInlineEndGap`). Passing the LTR formula in an RTL
   *  locale is what used to shove the panel off the window — the trigger sits
   *  near the LEFT edge there, so `innerWidth - rect.right` is nearly the full
   *  viewport width and the panel grew off-screen from there. Defaulted
   *  because the owner measures in a layout effect, which lands after this
   *  child's first commit. */
  anchorEnd?: number;
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
      if (target.closest('[data-anchored-menu-ignore]')) return;
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
        // Pin the inline-END edge to the trigger; the inline-start edge is free
        // to move as the content sizes it, which is what makes the menu grow
        // toward inline-start. Logical (`insetInlineEnd`), so under RTL this
        // resolves to `left` and the panel grows RIGHTWARD, into the window,
        // instead of off the edge it is anchored to.
        insetInlineEnd: anchorEnd,
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
        // z-[60] out-ranks the rail (z-50) outright: this hangs off the top bar,
        // which renders EARLIER in the DOM, so an equal z would lose the tie and
        // let the rail paint over the menu on a narrow window.
        'fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg',
        'transition-transform duration-200 ease-in-out',
        // Parked off the inline-END edge while closed, so the slide travels
        // toward the content. `translate-x-full` is PHYSICAL — Tailwind does not
        // mirror translations — so RTL needs the explicit negation, or the panel
        // would park on the far side and sail across the whole window to arrive.
        //
        // It must not hit-test there: a hover-driven owner would
        // otherwise receive pointerenter from its own off-screen panel while the
        // pointer is really on the trigger, reopen, slide away, get pointerleave,
        // close, slide back under the pointer — an oscillation that never
        // settles. Only a shown panel takes the pointer.
        shown ? 'translate-x-0' : 'translate-x-full rtl:-translate-x-full pointer-events-none',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {title != null && <div className="text-sm font-semibold text-foreground">{title}</div>}
        <div className="ms-auto flex items-center gap-1">
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
