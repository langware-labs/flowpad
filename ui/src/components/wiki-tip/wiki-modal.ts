import { createOverlayStore } from '@src/store/create-overlay-store';

/**
 * Global store backing `openWikiModal(wikiword)` — pops a wiki page in a modal
 * from anywhere (e.g. a WikiTip's hover preview). Store-driven, like the other
 * global overlays (`Spotlight`, `ActivityProgressModalRoot`): the CLAUDE.md
 * URL-first rule governs tab/view/asset navigation, not transient overlays.
 * See docs/wikitip.md.
 */
export interface WikiModalTarget {
  wikiword: string;
  space: string;
  /** Optional heading slug to scroll to once the page renders. */
  fragment?: string;
}

const store = createOverlayStore<WikiModalTarget>();
export const useWikiModalStore = store.useStore;
export const closeWikiModal = store.close;

/** Pop the wiki page `wikiword` (in `space`, default @local) in a modal,
 *  optionally scrolled to a heading `fragment`. */
export function openWikiModal(wikiword: string, space = '@local', fragment?: string): void {
  store.open({ wikiword, space, fragment });
}
