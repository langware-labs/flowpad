import { emitAppTopic, EventBus } from '@sdk';
import { useEffect } from 'react';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { dockTarget } from './dock-target';

/**
 * The UI-family bus adapter (docs/topics.md): the ONE place raw browser events
 * become topic events. Mounted once in App. Three normalizers:
 *
 * 1. Clicks — a single capture-phase passive listener; the nearest
 *    `[data-topic]` ancestor names the target → `app.ui.<kind>.clicked`.
 * 2. Routes — navigation COMPLETE (currentDock settled, so back/forward/
 *    reload/direct-URL all count) → `app.route.loaded`.
 * 3. Sandbox pages — the `flow-journey` postMessage bridge; a sandboxed
 *    iframe's `parent.postMessage({source:'flow-journey', event})` becomes
 *    `app.page.signal` with `origin: 'sandbox'` (least-trusted tier).
 *
 * Per the envelope law, nothing here ever carries user-entered values.
 */
export function UiTopicEmitter() {
  const { currentDock } = useDockNavigation();

  // 1. clicks on topic-tagged elements
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-topic]');
      const target = el?.dataset.topic;
      if (!target) return;
      emitAppTopic(`ui.${el.dataset.topicKind ?? 'label'}.clicked`, target);
    };
    document.addEventListener('click', onClick, { capture: true, passive: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, []);

  // 2. navigation complete
  const routeTarget = dockTarget(currentDock);
  useEffect(() => {
    emitAppTopic('route.loaded', routeTarget, {
      url: window.location.pathname + window.location.search,
      viewType: currentDock?.viewType ?? null,
      pointer: currentDock?.pointer ?? null,
    });
    // Emit on dock IDENTITY change only — option-only changes (highlight, lang,
    // journeyId itself) are not a navigation for await purposes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeTarget]);

  // 3. sandbox page signals
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { source?: string; event?: string } | null;
      if (d?.source !== 'flow-journey' || typeof d.event !== 'string') return;
      EventBus.emit('app.page.signal', d.event, {}, { origin: 'sandbox' });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return null;
}
