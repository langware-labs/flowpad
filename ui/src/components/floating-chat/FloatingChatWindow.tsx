import { Button } from '@src/components/ui/button';
import { ExternalLink, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import flowpadIcon from '@src/assets/flowpad-icon.png';
import { cn } from '@src/lib/utils';
import { topmost } from '@src/lib/topmost';
import { GENIE_DURATION_MS, GENIE_EASING, GENIE_SMALL_OPACITY, genieTransform } from '@src/lib/minimize-to-element';
import { useFloatingChat, type TriggerRect } from './FloatingChatContext';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import type { DockPointer } from '@src/navigation/DockPointer';
import { AssistantChat, loadPtyChatExperiment } from './AssistantChat';
import { Trans, useLingui } from '@lingui/react/macro';

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// v2: bumped defaults + new chrome — abandon old saved bounds.
const STORAGE_KEY = 'flowpad.floatingChat.bounds.v2';
const MIN_W = 420;
const MIN_H = 420;
const DEFAULT_W = 860;
const DEFAULT_H = 660;
const MARGIN = 16;

type Phase = 'closed' | 'opening' | 'open' | 'closing';

/** The assistant button the chat minimizes into: the first one actually laid out. */
function assistantButtonRect(): TriggerRect | null {
  if (typeof document === 'undefined') return null;
  for (const el of document.querySelectorAll<HTMLElement>('[data-minimize-anchor="assistant-button"]')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  return null;
}

function loadBounds(): Bounds | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Bounds>;
    if (
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      typeof parsed.width === 'number' &&
      typeof parsed.height === 'number'
    ) {
      return parsed as Bounds;
    }
  } catch {
    // ignore
  }
  return null;
}

function defaultBounds(): Bounds {
  if (typeof window === 'undefined') {
    return { x: 0, y: 0, width: DEFAULT_W, height: DEFAULT_H };
  }
  const width = Math.min(DEFAULT_W, window.innerWidth - MARGIN * 2);
  const height = Math.min(DEFAULT_H, window.innerHeight - MARGIN * 2);
  const x = Math.max(MARGIN, Math.round((window.innerWidth - width) / 2));
  const y = Math.max(MARGIN, Math.round((window.innerHeight - height) / 2));
  return { x, y, width, height };
}

function clampToViewport(b: Bounds): Bounds {
  if (typeof window === 'undefined') return b;
  const width = Math.max(MIN_W, Math.min(b.width, window.innerWidth - MARGIN * 2));
  const height = Math.max(MIN_H, Math.min(b.height, window.innerHeight - MARGIN * 2));
  const x = Math.max(MARGIN, Math.min(b.x, window.innerWidth - width - MARGIN));
  const y = Math.max(MARGIN, Math.min(b.y, window.innerHeight - height - MARGIN));
  return { x, y, width, height };
}

/**
 * Global floating Flowpad Assistant chat. Renders in a portal at document.body
 * so it floats above all routed content. Draggable by the title bar; resizable
 * via the bottom-right corner. Position and size persist in localStorage.
 *
 * Open/close is animated: on open, the window scales up from the trigger
 * button's on-screen rect into its centered position; on close, it scales
 * into the assistant button, however it was opened. The entrance transform is
 * derived from the `triggerRect` captured at click time; the exit one from the
 * assistant button's rect read at close time.
 */
export function FloatingChatWindow() {
  const { currentDock } = useDockNavigation();
  // The popped-out assistant IS the chat in its window; it never floats a second one.
  if (currentDock?.viewType === ViewType.ASSISTANT) return null;
  return <FloatingChatWindowInner />;
}

function FloatingChatWindowInner() {
  const { t } = useLingui();
  const { open, closeChat, triggerRect, restoredFromStorage, pendingAsk, consumeAsk, popOut, publishDock } =
    useFloatingChat();
  const { currentDock, windowMode } = useDockNavigation();
  const [ptyExperiment] = useState<boolean>(() => loadPtyChatExperiment());
  // The page whose chat is showing — a popout opens on that same chat.
  const boundUrlRef = useRef<string | null>(null);
  const onBoundChange = useCallback((dock: DockPointer | null) => {
    boundUrlRef.current = dock?.viewType ? dock.toUrl() : null;
  }, []);

  // A popped-out assistant follows the main window: report where we are. Other
  // `win/` windows are not "where the user is".
  // A URL naming no view (a deleted one, from an old link) parses to a pointer with no
  // view type, and toUrl() throws on it — during render, which took the whole app down
  // to the error page on /dock/execute-flow. Such a page reports as home.
  const dockUrl = currentDock?.viewType ? currentDock.toUrl() : '/';
  useEffect(() => {
    if (!windowMode) publishDock(dockUrl);
  }, [dockUrl, windowMode, publishDock]);

  const [bounds, setBounds] = useState<Bounds>(() => clampToViewport(loadBounds() ?? defaultBounds()));

  // Animation phase. Mount lifecycle is gated on `phase !== 'closed'` so the
  // node stays in the DOM while the close transition runs.
  // If `open` was restored from localStorage (the user reloaded with the chat
  // open), start in the resting `open` phase and skip the entrance animation
  // — there's no triggerRect to animate from after a refresh.
  const [phase, setPhase] = useState<Phase>(() => (restoredFromStorage && open ? 'open' : 'closed'));
  const [exitRect, setExitRect] = useState<TriggerRect | null>(null);

  useEffect(() => {
    if (open) {
      // Already at rest from a restored-open initial mount? Don't replay the
      // animation — the window is just sitting there as the user left it.
      setPhase((prev) => {
        if (prev === 'open') return prev;
        return 'opening';
      });
      const id = requestAnimationFrame(() => {
        // Two RAFs ensure the initial styles paint before transitioning.
        requestAnimationFrame(() => setPhase((prev) => (prev === 'closed' ? prev : 'open')));
      });
      return () => cancelAnimationFrame(id);
    }
    // Close: only run the closing transition if we were actually mounted.
    // Wherever the chat came from (the address bar's ask, a page's request
    // line), it minimizes into the assistant button — the one click that
    // brings it back — read where that button is NOW, not at open time.
    setExitRect(assistantButtonRect());
    setPhase((prev) => (prev === 'closed' ? 'closed' : 'closing'));
  }, [open]);

  // Re-clamp into the viewport when the window is opened or the browser resized.
  useEffect(() => {
    if (phase === 'closed') return;
    setBounds((prev) => clampToViewport(prev));
    const onResize = () => setBounds((prev) => clampToViewport(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [phase]);

  // Persist whenever bounds settle.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(bounds));
    } catch {
      // ignore quota / private mode
    }
  }, [bounds]);

  // Drag handling on the header.
  const dragStateRef = useRef<{ pointerId: number; offX: number; offY: number } | null>(null);
  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only the left button on the header itself starts a drag — buttons inside
      // the header set pointerdown to stopPropagation.
      if (e.button !== 0) return;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      dragStateRef.current = {
        pointerId: e.pointerId,
        offX: e.clientX - bounds.x,
        offY: e.clientY - bounds.y,
      };
    },
    [bounds.x, bounds.y],
  );

  const onHeaderPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setBounds((prev) => clampToViewport({ ...prev, x: e.clientX - drag.offX, y: e.clientY - drag.offY }));
  }, []);

  const onHeaderPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragStateRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // CSS `resize: both` mutates the element's inline style; mirror the size
  // back into React state so we can persist it. Skip during opening/closing
  // so the entrance animation doesn't fight the observer.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (phase !== 'open') return;
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Use borderBoxSize so the reading matches our inline `width`/`height`
        // (Tailwind sets box-sizing: border-box globally). Reading contentRect
        // would feedback-loop with the border/padding subtracted each tick.
        const box = entry.borderBoxSize?.[0];
        const w = Math.round(box?.inlineSize ?? entry.contentRect.width);
        const h = Math.round(box?.blockSize ?? entry.contentRect.height);
        setBounds((prev) =>
          prev.width === w && prev.height === h ? prev : clampToViewport({ ...prev, width: w, height: h }),
        );
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase]);

  if (typeof document === 'undefined') return null;
  // Note: the dialog stays mounted in the closed phase too (with `display: none`)
  // so the inner <EntityExecutionPanel>'s state — picked session, in-flight
  // localProcess, attached refs — survives close→reopen cycles. Only a full
  // refresh resets it.
  const isClosed = phase === 'closed';

  // Use the same dedicated round Flowpad icon as the trigger button for visual
  // continuity. siteConfig branding stays out of this surface — see the button
  // component for the rationale.
  const logoSrc = flowpadIcon;

  // Compute the entrance/exit transform that starts at the trigger button's
  // rect and ends at identity (the centered window position).
  const isAtRest = phase === 'open';
  const buttonRect = phase === 'closing' ? (exitRect ?? triggerRect) : triggerRect;
  // Maximize-from: the window grows out of the button the way a minimize
  // flies into it — the same flight, timing and small-end opacity, played
  // backwards. Without a rect (opened from code) it grows from its own center.
  const startTransform = buttonRect
    ? genieTransform(
        { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height },
        { left: buttonRect.x, top: buttonRect.y, width: buttonRect.width, height: buttonRect.height },
      )
    : 'scale(0.1)';

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-label={t`Flowpad Assistant`}
      data-testid="floating-chat-window"
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget) return;
        if (phase === 'closing' && e.propertyName === 'transform') {
          setPhase('closed');
        }
      }}
      className={cn(topmost, 'overflow-hidden')}
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        minWidth: MIN_W,
        minHeight: MIN_H,
        resize: isAtRest ? 'both' : 'none',
        transformOrigin: 'center center',
        transform: isAtRest ? 'translate(0, 0) scale(1)' : startTransform,
        opacity: isAtRest ? 1 : GENIE_SMALL_OPACITY,
        transition: `transform ${GENIE_DURATION_MS}ms ${GENIE_EASING}, opacity ${GENIE_DURATION_MS}ms ${GENIE_EASING}`,
        willChange: 'transform, opacity',
        // Keep the node mounted across close/open so the inner panel's session
        // state survives. `display: none` removes it from the layout cleanly
        // and stops it from intercepting clicks.
        display: isClosed ? 'none' : undefined,
        pointerEvents: isClosed ? 'none' : undefined,
      }}
    >
      <div
        className="flex flex-shrink-0 cursor-move select-none items-center gap-2 border-b bg-muted/40 px-2 py-1.5"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
        data-testid="floating-chat-drag-handle"
      >
        <img src={logoSrc} alt="" className="h-5 w-5 flex-shrink-0 object-contain" />
        <span className="flex-1 truncate text-xs font-medium">
          <Trans>Flowpad Assistant</Trans>
          {ptyExperiment && (
            <span
              className="ms-1.5 rounded bg-amber-500/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400"
              data-testid="floating-chat-pty-experiment-badge"
            >
              <Trans>pty experiment</Trans>
            </span>
          )}
        </span>
        {/* The floating window covers the page; this is the way out to a window of
            its own beside Flowpad — so it is a labelled button, not a glyph. */}
        <Button
          type="button"
          variant="default"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs font-medium"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => popOut(boundUrlRef.current)}
          title={t`Open the assistant in its own window, beside Flowpad`}
          data-testid="floating-chat-popout"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          <Trans>Open in new window</Trans>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={closeChat}
          title={t`Close`}
          data-testid="floating-chat-close"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <AssistantChat
        followedDock={currentDock}
        visible={!isClosed && open}
        pendingAsk={pendingAsk}
        onAskConsumed={consumeAsk}
        onBoundChange={onBoundChange}
      />
    </div>,
    document.body,
  );
}
