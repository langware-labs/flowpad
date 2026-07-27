import { create } from 'zustand';

/**
 * Global store backing `openWikiModal(wikiword)` — pops a wiki page in a modal
 * from anywhere (e.g. a WikiTip's hover preview). Store-driven, like the other
 * global overlays (`Spotlight`, `ActivityProgressModalRoot`): the CLAUDE.md
 * URL-first rule governs tab/view/asset navigation, not transient overlays.
 * See docs/wikitip.md.
 */
interface WikiModalStore {
  open: boolean;
  wikiword: string;
  space: string;
  /** Optional heading slug to scroll to once the page renders. */
  fragment?: string;
  show: (wikiword: string, space?: string, fragment?: string) => void;
  setOpen: (v: boolean) => void;
}

export const useWikiModalStore = create<WikiModalStore>((set) => ({
  open: false,
  wikiword: '',
  space: '@local',
  fragment: undefined,
  show: (wikiword, space = '@local', fragment) => set({ open: true, wikiword, space, fragment }),
  setOpen: (v) => set({ open: v }),
}));

/** Pop the wiki page `wikiword` (in `space`, default @local) in a modal,
 *  optionally scrolled to a heading `fragment`. */
export function openWikiModal(wikiword: string, space = '@local', fragment?: string): void {
  useWikiModalStore.getState().show(wikiword, space, fragment);
}
