import { useEffect } from 'react';

/**
 * Call `onChange` when a `data-tag`-carrying element enters or leaves the page.
 *
 * THE one place the tagged-DOM watch is tuned. Two consumers need it — the
 * highlight ring (which must follow late mounts and re-rendered replacements)
 * and a journey's `element` condition — and they had byte-identical observers
 * with the same hand-copied dampeners, which is two places to get the
 * performance contract wrong.
 *
 * Two dampeners, and both matter in an app with streaming chat and live process
 * output:
 *
 *  - **coalesce first.** One check per animation frame. The rAF guard is tested
 *    BEFORE the scan below, so a burst pays for one scan, not one per batch.
 *  - **then filter.** Only mutations whose added/removed nodes are (or contain)
 *    a tagged element are worth a re-check. Text nodes fail the `HTMLElement`
 *    test immediately, so streaming text costs almost nothing.
 *
 * `enabled` is honoured by not observing at all — a journey step that watches no
 * elements should not pay for an observer.
 */
export function useTaggedDomChanges(onChange: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof MutationObserver === 'undefined') return;
    let raf = 0;
    const touchesTag = (records: MutationRecord[]) =>
      records.some((r) =>
        [...r.addedNodes, ...r.removedNodes].some(
          (n) => n instanceof HTMLElement && (n.dataset.tag !== undefined || n.querySelector('[data-tag]') !== null),
        ),
      );
    const observer = new MutationObserver((records) => {
      // Coalesce BEFORE scanning: the scan walks subtrees, and a queued frame
      // already covers whatever this batch would have found.
      if (raf) return;
      if (!touchesTag(records)) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        onChange();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [onChange, enabled]);
}

/** The selector for a tag word. `CSS.escape` is absent in some DOM environments
 *  (jsdom), so the fallback lives here rather than being re-spelled per call. */
export function tagSelector(word: string): string {
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(word)
      : word.replace(/["\\]/g, '\\$&');
  return `[data-tag="${escaped}"]`;
}
