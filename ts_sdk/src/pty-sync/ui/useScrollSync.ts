import { useState, useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { IXtermAdapter } from '../adapter/XtermAdapter.js';
import type { ExpectedLineCoord } from '../types.js';
import { computeStreamMetrics, type StreamMetrics } from '../scroll/StreamMetrics.js';

/**
 * Subscribe to xterm scroll events and recompute StreamMetrics on every change.
 *
 * @param term  - live xterm Terminal (null-safe: returns null until mounted)
 * @param adapter - live IXtermAdapter wrapping the same terminal
 * @param coords  - all known packet coords from LineRegistry.all()
 */
export function useScrollSync(
  term: Terminal | null,
  adapter: IXtermAdapter | null,
  coords: ExpectedLineCoord[],
): StreamMetrics | null {
  const [metrics, setMetrics] = useState<StreamMetrics | null>(null);
  // Keep a stable ref to coords so the effect doesn't re-run on every render
  const coordsRef = useRef(coords);
  coordsRef.current = coords;

  useEffect(() => {
    if (!term || !adapter) return;

    const recompute = () =>
      setMetrics(computeStreamMetrics(adapter, coordsRef.current));

    // Compute immediately so components don't wait for first scroll
    recompute();

    // term.onScroll fires for buffer scrolling (data writes push lines off).
    const disposable = term.onScroll(recompute);

    // The native DOM 'scroll' event on .xterm-viewport fires for user-initiated
    // viewport scrolling (mouse wheel, trackpad, keyboard). xterm v5 does NOT
    // re-emit these through terminal.onScroll, so we must listen here directly.
    const viewport = term.element?.querySelector('.xterm-viewport');
    viewport?.addEventListener('scroll', recompute, { passive: true });

    return () => {
      disposable.dispose();
      viewport?.removeEventListener('scroll', recompute);
    };
  }, [term, adapter]);

  // Recompute whenever coords change (new packets pushed after generate/run).
  // Use coordsRef to avoid re-running when callers pass a new [] reference on
  // every render (which would cause an infinite setState → render loop).
  useEffect(() => {
    if (!adapter) return;
    setMetrics(computeStreamMetrics(adapter, coordsRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, coords.length]);

  return metrics;
}
