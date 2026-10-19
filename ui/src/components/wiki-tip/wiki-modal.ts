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
  /** Wiki id/@uname or the project-scoped `@local` alias. Left undefined, the
   *  modal looks the page up in the shipped docs (the assistant project's wiki)
   *  — which is where every page a help affordance names actually lives. */
  space?: string;
  /** Optional heading slug to scroll to once the page renders. */
  fragment?: string;
}

const store = createOverlayStore<WikiModalTarget>();
export const useWikiModalStore = store.useStore;
export const closeWikiModal = store.close;

/** Pop the wiki page `wikiword` in a modal, optionally scrolled to a heading
 *  `fragment`. Pass `space` only for a page outside the shipped docs. */
export function openWikiModal(wikiword: string, space?: string, fragment?: string): void {
  store.open({ wikiword, space, fragment });
}
