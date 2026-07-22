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
 * highlight a word (`?highlight=`), EVERY element tagged `data-topic="<word>"`
 * gets the standard ring + beacon with the entry pulse — several surfaces may
 * carry the same topic (the footer project name AND the rail's project icon),
 * and each is a valid way to act, so each lights. No per-component wiring;
 * components only declare `topicTag(...)`.
 *
 * The URL is the state: the ring PERSISTS while `?highlight=` names the topic
 * (a journey step's param stands until the step advances). A timed fade raced
 * cold boots — the whole window burned during app loading. The set of live
 * elements is tracked continuously (MutationObserver + a slow re-sync), so
 * late mounts and re-rendered replacements keep their highlight.
 */
export function TopicHighlightObserver() {
  const word = useHighlight();
  const [els, setEls] = useState<HTMLElement[]>([]);
  const [phase, setPhase] = useState<HighlightPhase>('idle');

  // Track the LIVE set of tagged elements for the whole highlight window.
  useEffect(() => {
    if (!word) {
      setEls([]);
      return;
    }
    // CSS.escape is absent in some DOM environments (jsdom) — quote-escape fallback.
    const esc =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(word)
        : word.replace(/["\\]/g, '\\$&');
    const findAll = () =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-topic="${esc}"]`));
    const sync = () =>
      setEls((prev) => {
        const next = findAll();
        // Keep the previous array identity when the set is unchanged, so the
        // effects below don't churn on every mutation/tick.
        if (prev.length === next.length && prev.every((el, i) => el === next[i])) return prev;
        return next;
      });
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    // Belt and braces: a slow re-sync catches anything the observer misses
    // during cold-boot render churn. Exists only while a highlight is requested.
    const interval = window.setInterval(sync, 500);
    return () => {
      observer.disconnect();
      window.clearInterval(interval);
    };
  }, [word]);

  // Lifecycle: enter (brief attention pulse) → linger — and STAY until the
  // word clears or the element set changes (which replays the entry pulse).
  useEffect(() => {
    if (!word || els.length === 0) {
      setPhase('idle');
      return;
    }
    setPhase('enter');
    const toLinger = window.setTimeout(() => setPhase('linger'), HIGHLIGHT_ENTER_MS);
    return () => window.clearTimeout(toLinger);
  }, [word, els]);

  // Decorate every live element; cleanup restores each exactly.
  useEffect(() => {
    if (els.length === 0 || phase === 'idle') return;
    const undo = els.map((el) => {
      const madeRelative = getComputedStyle(el).position === 'static';
      if (madeRelative) el.classList.add('relative');
      el.classList.add(...RING_CLASSES);
      if (phase === 'enter') el.classList.add('animate-pulse');
      el.setAttribute('data-highlighted', 'true');
      return { el, madeRelative };
    });
    if (phase === 'enter') els[0]?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    return () => {
      for (const { el, madeRelative } of undo) {
        el.classList.remove(...RING_CLASSES, 'animate-pulse');
        if (madeRelative) el.classList.remove('relative');
        el.removeAttribute('data-highlighted');
      }
    };
  }, [els, phase]);

  if (phase === 'idle') return null;
  return <>{els.map((el, i) => createPortal(<HighlightBeacon key={i} />, el))}</>;
}
