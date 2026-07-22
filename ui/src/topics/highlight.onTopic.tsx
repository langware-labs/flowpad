import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { HighlightBeacon } from '@src/components/wiki-tip/HighlightBeacon';
import {
  HIGHLIGHT_ENTER_MS,
  HIGHLIGHT_LINGER_MS,
  useHighlight,
  type HighlightPhase,
} from '@src/components/wiki-tip/highlight';

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

  // Locate the tagged element — immediately, or when it mounts.
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
    const found = find();
    if (found) {
      setEl(found);
      return;
    }
    setEl(null);
    const observer = new MutationObserver(() => {
      const late = find();
      if (late) {
        setEl(late);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [word]);

  // The standard lifecycle: enter (attention) → linger (calm) → idle (fade).
  useEffect(() => {
    if (!word || !el) {
      setPhase('idle');
      return;
    }
    setPhase('enter');
    const toLinger = window.setTimeout(() => setPhase('linger'), HIGHLIGHT_ENTER_MS);
    const toIdle = window.setTimeout(() => setPhase('idle'), HIGHLIGHT_ENTER_MS + HIGHLIGHT_LINGER_MS);
    return () => {
      window.clearTimeout(toLinger);
      window.clearTimeout(toIdle);
    };
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
