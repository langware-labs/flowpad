import { useAgentContext } from '@src/contexts/agent-context';
import { BASE_PATH } from '@src/constants/basePath';
import { Button } from '@src/components/ui/button';
import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { ProcessType } from '@sdk';
import { cn } from '@src/lib/utils';
import { X } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFloatingChat } from './FloatingChatContext';
import { useFlowpadAssistantProject } from './useFlowpadAssistantProject';

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const STORAGE_KEY = 'flowpad.floatingChat.bounds';
const MIN_W = 320;
const MIN_H = 360;
const DEFAULT_W = 420;
const DEFAULT_H = 560;
const MARGIN = 16;

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
  const x = Math.max(MARGIN, window.innerWidth - DEFAULT_W - MARGIN);
  const y = Math.max(MARGIN, window.innerHeight - DEFAULT_H - MARGIN);
  return { x, y, width: DEFAULT_W, height: DEFAULT_H };
}

function clampToViewport(b: Bounds): Bounds {
  if (typeof window === 'undefined') return b;
  const width = Math.max(MIN_W, Math.min(b.width, window.innerWidth - MARGIN * 2));
  const height = Math.max(MIN_H, Math.min(b.height, window.innerHeight - MARGIN * 2));
  const x = Math.max(MARGIN, Math.min(b.x, window.innerWidth - width - MARGIN));
  const y = Math.max(MARGIN, Math.min(b.y, window.innerHeight - height - MARGIN));
  return { x, y, width, height };
}

function isAbsoluteUrl(url: string) {
  return /^https?:\/\//i.test(url);
}

/**
 * Global floating Flowpad Assistant chat. Renders in a portal at document.body
 * so it floats above all routed content. Draggable by the title bar; resizable
 * via the bottom-right corner. Position and size persist in localStorage.
 */
export function FloatingChatWindow() {
  const { open, closeChat } = useFloatingChat();
  const { target, isLoading } = useFlowpadAssistantProject();
  const { agent } = useAgentContext();
  const siteConfig = agent?.site_config;
  const { resolvedTheme } = useTheme();

  const [bounds, setBounds] = useState<Bounds>(() =>
    clampToViewport(loadBounds() ?? defaultBounds()),
  );

  // Re-clamp into the viewport when the window is opened or the browser resized.
  useEffect(() => {
    if (!open) return;
    setBounds((prev) => clampToViewport(prev));
    const onResize = () => setBounds((prev) => clampToViewport(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

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
    setBounds((prev) =>
      clampToViewport({ ...prev, x: e.clientX - drag.offX, y: e.clientY - drag.offY }),
    );
  }, []);

  const onHeaderPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragStateRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // CSS `resize: both` mutates the element's inline style; mirror the size
  // back into React state so we can persist it.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        const w = Math.round(cr.width);
        const h = Math.round(cr.height);
        setBounds((prev) =>
          prev.width === w && prev.height === h ? prev : clampToViewport({ ...prev, width: w, height: h }),
        );
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const branded = siteConfig?.branding?.logo_url;
  const logoSrc = branded
    ? isAbsoluteUrl(branded)
      ? branded
      : `${BASE_PATH}${branded}`
    : 'logo.png';
  const invert =
    !!branded && resolvedTheme === 'dark' && !!siteConfig?.branding?.use_brightness_filter;

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Flowpad Assistant"
      data-testid="floating-chat-window"
      className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        minWidth: MIN_W,
        minHeight: MIN_H,
        resize: 'both',
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
        <img
          src={logoSrc}
          alt=""
          className={cn('h-5 w-5 flex-shrink-0 object-contain', invert && 'brightness-0 invert')}
        />
        <span className="flex-1 truncate text-xs font-medium">Flowpad Assistant</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={closeChat}
          title="Close"
          data-testid="floating-chat-close"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {target ? (
          <EntityExecutionPanel
            target={target}
            processType={ProcessType.Chat}
            className="h-full"
            emptyStateText="Ask the Flowpad Assistant anything."
            newSessionLabel="New chat"
            historyLabel="Chat history"
            pastSessionsLabel="Past chats"
            noPastSessionsLabel="No past chats"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {isLoading ? 'Loading Flowpad Assistant…' : 'Flowpad Assistant project not available.'}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
