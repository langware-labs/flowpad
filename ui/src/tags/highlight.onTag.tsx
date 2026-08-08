import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { HighlightBeacon } from '@src/components/wiki-tip/HighlightBeacon';
import { HIGHLIGHT_ENTER_MS, useHighlight, type HighlightPhase } from '@src/components/wiki-tip/highlight';
import { tagSelector, useTaggedDomChanges } from './use-tagged-dom-changes';

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
 * The generic tag-highlight observer — the highlight half of "one tag, three
 * powers". Mounted once beside {@link UiTagEmitter}: whenever the URL asks to
 * highlight a word (`?highlight=`), EVERY element tagged `data-tag="<word>"`
 * gets the standard ring + beacon with the entry pulse — several surfaces may
 * carry the same tag (the footer project name AND the rail's project icon),
 * and each is a valid way to act, so each lights. No per-component wiring;
 * components only declare `tagAttrs(...)`.
 *
 * The URL is the state: the ring PERSISTS while `?highlight=` names the tag
 * (a journey step's param stands until the step advances). A timed fade raced
 * cold boots — the whole window burned during app loading. The set of live
 * elements is tracked continuously (MutationObserver + a slow re-sync), so
 * late mounts and re-rendered replacements keep their highlight.
 */
export function TagHighlightObserver() {
  const word = useHighlight();
  const [els, setEls] = useState<HTMLElement[]>([]);
  const [phase, setPhase] = useState<HighlightPhase>('idle');

  // Track the LIVE set of tagged elements for the whole highlight window.
  // Hoisted out of the effect so the shared DOM watch below can call the same
  // function the cold-boot poll does — one definition of "re-read the set".
  const sync = useCallback(() => {
    if (!word) {
      setEls([]);
      return;
    }
    setEls((prev) => {
      const next = Array.from(document.querySelectorAll<HTMLElement>(tagSelector(word)));
      // Keep the previous array identity when the set is unchanged, so the
      // effects below don't churn on every mutation/tick.
      if (prev.length === next.length && prev.every((el, i) => el === next[i])) return prev;
      return next;
    });
  }, [word]);

  useEffect(() => {
    sync();
    if (!word) return;
    // Cold-boot only: render churn during app boot once slipped past the
    // observer, so poll until the first hit. The interval clears itself once
    // anything is found; from there the shared observer alone tracks
    // replacements.
    const interval = window.setInterval(() => {
      sync();
      if (document.querySelector(tagSelector(word))) window.clearInterval(interval);
    }, 500);
    return () => window.clearInterval(interval);
  }, [word, sync]);

  // The tagged-DOM watch is shared (`useTaggedDomChanges`) so the ring and a
  // journey's `element` condition cannot drift on how it is dampened. The
  // highlight is PERSISTENT, so it stays armed for the whole step.
  useTaggedDomChanges(sync, !!word);

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
