import { PanelLeft, PanelLeftClose } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { BrowseableTree, ToolbarButton } from '@src/components/browseable-tree/BrowseableTree';
import type { NavigatorDescriptor, NavigatorWidth } from './types';

const DEFAULT_WIDTH: NavigatorWidth = { default: 224, min: 160, max: 560 };

/** This navigator's own persisted open/closed choice, or `null` if never set,
 *  so the default (open) applies only on first sight — an explicit '0' (open)
 *  is remembered, not re-derived from the default. */
function readCollapsed(id: string): boolean | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(`navigator:${id}:collapsed`);
  return raw == null ? null : raw === '1';
}

function readWidth(id: string, bounds: NavigatorWidth, legacyKeys?: { width?: string }): number {
  if (typeof window === 'undefined') return bounds.default;
  const raw =
    window.localStorage.getItem(`navigator:${id}:width`) ??
    (legacyKeys?.width ? window.localStorage.getItem(legacyKeys.width) : null);
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return bounds.default;
  return Math.max(bounds.min, Math.min(bounds.max, n));
}

/**
 * NavigatorPanel — the single shared left-menu chrome (Zone B). Owns collapse +
 * drag-resize + localStorage persistence (keyed by `descriptor.id`) and renders
 * the header + the BrowseableTree row engine. One instance per active view; the
 * navigator registry chooses which descriptor to feed it.
 *
 * Collapsed → a slim rail with just the expand toggle (so the affordance stays
 * inside the panel column). Expanded → full width with a drag-resize handle.
 */
export function NavigatorPanel({
  descriptor,
  /** One-time legacy localStorage fallback (e.g. Assets' wiki:sidebar-*). */
  legacyKeys,
}: {
  descriptor: NavigatorDescriptor;
  legacyKeys?: { width?: string };
}) {
  const bounds = descriptor.width ?? DEFAULT_WIDTH;
  const { id } = descriptor;
  const { t } = useLingui();

  // Open by default on first sight; an explicit choice (incl. '0' = open) is
  // remembered across reloads.
  const [collapsed, setCollapsed] = useState(() => readCollapsed(id) ?? false);
  const [width, setWidth] = useState<number>(() => readWidth(id, bounds, legacyKeys));
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(`navigator:${id}:collapsed`, collapsed ? '1' : '0');
  }, [id, collapsed]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(`navigator:${id}:width`, String(width));
  }, [id, width]);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      setIsResizing(true);
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const onMove = (ev: MouseEvent) => {
        setWidth(Math.max(bounds.min, Math.min(bounds.max, startWidth + (ev.clientX - startX))));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        setIsResizing(false);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [width, bounds.min, bounds.max],
  );

  // Rendered inline (not memoized): the descriptor is rebuilt by the navigator
  // each render, so a memo keyed on it would never hit; BrowseableTree does its
  // own internal memoization.
  const tree = (
    <BrowseableTree
      roots={descriptor.roots ?? []}
      activePointer={descriptor.activePointer ?? null}
      activeKey={descriptor.activeKey}
      isLoading={descriptor.isLoading}
      onNavigate={descriptor.onNavigate}
      emptyState={descriptor.emptyState}
    />
  );

  if (collapsed) {
    return (
      <div className="flex w-9 flex-shrink-0 flex-col items-center border-r py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title={descriptor.header?.title ? t`Show ${descriptor.header.title}` : t`Show panel`}
          aria-label={t`Expand navigator`}
          className="flex h-7 w-7 items-center justify-center rounded hover:bg-muted"
          data-testid={`navigator-expand-${id}`}
        >
          <PanelLeft className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
    );
  }

  const header = descriptor.header;

  return (
    <>
      <div
        className="flex-shrink-0 overflow-hidden border-r"
        style={{ width }}
        data-testid={`navigator-panel-${id}`}
      >
        <div className="flex h-full flex-col" style={{ width }}>
          {header && (
            <div className="flex flex-shrink-0 items-center gap-1 border-b px-1.5 py-1">
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                title={header.title ? t`Hide ${header.title}` : t`Hide panel`}
                aria-label={t`Collapse navigator`}
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded hover:bg-muted"
                data-testid={`navigator-collapse-${id}`}
              >
                <PanelLeftClose className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
              {header.title && (
                <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">{header.title}</span>
              )}
              {header.countBadge != null && header.countBadge > 0 && (
                <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium leading-4 text-muted-foreground">
                  {header.countBadge}
                </span>
              )}
              {(header.headerRight || (header.toolbar && header.toolbar.length > 0)) && (
                <div className="ml-auto flex flex-shrink-0 items-center gap-0.5">
                  {header.headerRight}
                  {header.toolbar?.map((a) => (
                    <ToolbarButton key={a.id} action={a} />
                  ))}
                </div>
              )}
            </div>
          )}
          {header?.filterBar && (
            <div className="flex flex-shrink-0 items-center gap-1 border-b p-1.5">{header.filterBar}</div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {descriptor.customBody ?? (descriptor.wrapTree ? descriptor.wrapTree(tree) : tree)}
          </div>
        </div>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t`Resize navigator`}
        onMouseDown={handleResizeStart}
        onDoubleClick={() => setWidth(bounds.default)}
        className={`group relative w-1 flex-shrink-0 cursor-col-resize select-none ${
          isResizing ? 'bg-primary/40' : 'hover:bg-primary/30'
        }`}
        data-testid={`navigator-resize-${id}`}
      />
    </>
  );
}
