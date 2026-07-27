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
    const findAll = () => Array.from(document.querySelectorAll<HTMLElement>(`[data-tag="${esc}"]`));
    let interval = 0;
    const sync = () =>
      setEls((prev) => {
        const next = findAll();
        // The cold-boot poll has done its job once anything is found; from
        // here the (filtered) MutationObserver alone tracks replacements.
        if (next.length > 0 && interval) {
          window.clearInterval(interval);
          interval = 0;
        }
        // Keep the previous array identity when the set is unchanged, so the
        // effects below don't churn on every mutation/tick.
        if (prev.length === next.length && prev.every((el, i) => el === next[i])) return prev;
        return next;
      });
    sync();
    // The highlight is PERSISTENT, so this observer lives for the whole step —
    // it must not cost a full-tree query per unrelated mutation (streaming
    // chat, live process output). Two dampeners: only mutations whose
    // added/removed nodes are (or contain) a tagged element trigger a
    // re-sync, and bursts coalesce into one query per animation frame.
    let rafId = 0;
    const touchesTag = (records: MutationRecord[]) =>
      records.some((r) =>
        [...r.addedNodes, ...r.removedNodes].some(
          (n) => n instanceof HTMLElement && (n.dataset.tag !== undefined || n.querySelector('[data-tag]') !== null),
        ),
      );
    const observer = new MutationObserver((records) => {
      if (!touchesTag(records)) return;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        sync();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Cold-boot only: render churn during app boot once slipped past the
    // observer, so poll until the first hit — sync() self-cancels it.
    interval = window.setInterval(sync, 500);
    return () => {
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      if (interval) window.clearInterval(interval);
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
