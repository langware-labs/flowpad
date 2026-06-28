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
  show: (wikiword: string, space?: string) => void;
  setOpen: (v: boolean) => void;
}

export const useWikiModalStore = create<WikiModalStore>((set) => ({
  open: false,
  wikiword: '',
  space: '@local',
  show: (wikiword, space = '@local') => set({ open: true, wikiword, space }),
  setOpen: (v) => set({ open: v }),
}));

/** Pop the wiki page `wikiword` (in `space`, default @local) in a modal. */
export function openWikiModal(wikiword: string, space = '@local'): void {
  useWikiModalStore.getState().show(wikiword, space);
}
