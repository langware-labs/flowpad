import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { HighlightBeacon } from '@src/components/wiki-tip/HighlightBeacon';
import { HIGHLIGHT_ENTER_MS, useHighlight, type HighlightPhase } from '@src/components/wiki-tip/highlight';

/** The standard highlight treatment, applied generically (same classes the
 *  wiki-tip components use — see docs/wikitip.md). */
const RING_CLASSES = [
  'border-primary',
  'bg-primary/5',
  'ring-2',
  'ring-primary',
  'ring-offset-1',
  'ring-offset-background',
  'transition-all',
  'duration-500',
];

/**
 * The generic topic-highlight observer — the highlight half of "one tag, three
 * powers". Mounted once beside {@link UiTopicEmitter}: whenever the URL asks to
 * highlight a word (`?highlight=`), the element tagged `data-topic="<word>"`
 * gets the standard ring + beacon + scroll-into-view with the standard
 * enter→linger→fade lifecycle — no per-component highlight wiring. Components
 * only declare `topicTag(...)`; a journey lights them with `present.highlight`.
 *
 * Late mounts are covered: if the tagged element isn't in the DOM yet (the
 * journey often navigates and highlights in one step), a MutationObserver waits
 * for it.
 */
export function TopicHighlightObserver() {
  const word = useHighlight();
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [phase, setPhase] = useState<HighlightPhase>('idle');

  // Track the LIVE tagged element for the whole highlight window. The observer
  // never stops while the word is set: on a cold load the target is often found
  // early and then REPLACED when its surface re-renders (the footer once
  // project context loads) — holding the first node would orphan the highlight,
  // so re-resolve whenever the held node leaves the DOM.
  useEffect(() => {
    if (!word) {
      setEl(null);
      return;
    }
    // CSS.escape is absent in some DOM environments (jsdom) — quote-escape fallback.
    const esc =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(word)
        : word.replace(/["\\]/g, '\\$&');
    const find = () => document.querySelector<HTMLElement>(`[data-topic="${esc}"]`);
    const sync = () => setEl((prev) => (prev && prev.isConnected ? prev : find()));
    sync();
    // Two wake-ups, belt and braces: MutationObserver for the common case, and
    // a slow interval that catches anything it misses during cold-boot render
    // churn (the interval only exists while a highlight is requested — one
    // querySelector per tick, nothing on the steady state).
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    const interval = window.setInterval(sync, 500);
    return () => {
      observer.disconnect();
      window.clearInterval(interval);
    };
  }, [word]);

  // Lifecycle: enter (brief attention pulse) → linger — and STAY there. The
  // URL is the state: while `?highlight=` names this topic the ring persists
  // (for a journey step the param stands until the step advances). A timed
  // fade here raced cold boots — the whole 5.6s window burned during app
  // loading, so the user never saw it. The wiki feed's component-local
  // useLingeringHighlight keeps its own fade; this generic observer does not.
  useEffect(() => {
    if (!word || !el) {
      setPhase('idle');
      return;
    }
    setPhase('enter');
    const toLinger = window.setTimeout(() => setPhase('linger'), HIGHLIGHT_ENTER_MS);
    return () => window.clearTimeout(toLinger);
  }, [word, el]);

  // Decorate the live element; cleanup restores it exactly.
  useEffect(() => {
    if (!el || phase === 'idle') return;
    const madeRelative = getComputedStyle(el).position === 'static';
    if (madeRelative) el.classList.add('relative');
    el.classList.add(...RING_CLASSES);
    if (phase === 'enter') {
      el.classList.add('animate-pulse');
      el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    }
    el.setAttribute('data-highlighted', 'true');
    return () => {
      el.classList.remove(...RING_CLASSES, 'animate-pulse');
      if (madeRelative) el.classList.remove('relative');
      el.removeAttribute('data-highlighted');
    };
  }, [el, phase]);

  return el && phase !== 'idle' ? createPortal(<HighlightBeacon />, el) : null;
}
