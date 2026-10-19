/**
 * Unsent composer text, keyed by conversation.
 *
 * Navigating away from a chat unmounts the whole `FlowPage` subtree, so the
 * composer's `useState` draft dies with it and the user comes back to an empty
 * box (FLOWPAD-2035). A per-mount ref cannot help — the mount is exactly what
 * goes away.
 *
 * Storage rather than a module-scope Map, because a module lives only as long
 * as the RENDERER: F5 (or an Electron window reload) tears the JS heap down and
 * takes every pending draft with it. And sessionStorage rather than
 * localStorage because its lifetime is exactly the one the ticket describes —
 * per tab, survives a reload, gone when the window closes, so a draft never
 * outlives the app it was typed into. Same reasoning, and the same choice, as
 * `navigation/history-position-store.ts` and `journey/journey-dismissed.ts`.
 *
 * Per-TAB is a feature, not a side effect: two windows on the same chat are two
 * places to type, and each keeps the text its own user actually left there.
 *
 * Keyed by conversation so two chats cannot shadow each other: a draft typed at
 * one agent must never surface in the composer of another, where a stray Enter
 * would send it to the wrong place.
 *
 * Every access is wrapped: storage throws outright in private mode, when site
 * data is blocked, and under SSR/jsdom-without-storage. A composer that cannot
 * persist its draft must still work, so failures degrade to "no draft kept"
 * rather than taking the input down with them.
 */
const PREFIX = 'flowpad.composer.draft.';

const storageKey = (scope: string) => `${PREFIX}${scope}`;

/** The stored draft for `scope`, or '' when there is none (or no scope). */
export function readDraft(scope: string | undefined): string {
  if (!scope) return '';
  try {
    return sessionStorage.getItem(storageKey(scope)) ?? '';
  } catch {
    // No storage — the composer just opens empty.
    return '';
  }
}

/**
 * Store `text` for `scope`. An empty draft is removed rather than stored, so a
 * sent or cleared composer leaves nothing behind and storage holds only what is
 * actually pending.
 */
export function writeDraft(scope: string | undefined, text: string): void {
  if (!scope) return;
  try {
    if (text === '') sessionStorage.removeItem(storageKey(scope));
    else sessionStorage.setItem(storageKey(scope), text);
  } catch {
    // Private mode / quota — the draft is not kept, nothing else breaks.
  }
}

/** Forget every pending draft. Test seam, and the reset for a wiped tab. */
export function resetComposerDrafts(): void {
  try {
    // Collect first: removing during the index walk reshuffles what is left.
    const ours: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(PREFIX)) ours.push(key);
    }
    for (const key of ours) sessionStorage.removeItem(key);
  } catch {
    // Nothing to clear if there is no storage to begin with.
  }
}
