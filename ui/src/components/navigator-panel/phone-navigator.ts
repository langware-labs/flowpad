import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { create } from 'zustand';

/**
 * The navigator on a phone (below `md`): a drawer over the content instead of a column beside it. The
 * panel stays mounted where it is — only CSS moves it — so the tree keeps its state. This is the drawer's
 * open/closed bit, and whether a navigator is on screen at all (the phone bar's Browse button asks).
 *
 * A store, not the URL: like any overlay, the drawer is transient. What a row in it OPENS is URL-first.
 */
const useStore = create(() => ({ open: false, mounted: 0 }));

export const usePhoneNavigatorOpen = () => useStore((s) => s.open);
export const useHasPhoneNavigator = () => useStore((s) => s.mounted > 0);
export const setPhoneNavigatorOpen = (open: boolean) => useStore.setState({ open });

/** A mounted navigator panel announces itself; the last one to leave closes the drawer, and so does
 *  any navigation — picking a row in it. */
export function usePhoneNavigatorPresence(): void {
  useEffect(() => {
    useStore.setState((s) => ({ mounted: s.mounted + 1 }));
    return () => useStore.setState((s) => ({ mounted: s.mounted - 1, open: s.mounted > 1 && s.open }));
  }, []);
  const { key } = useLocation();
  useEffect(() => setPhoneNavigatorOpen(false), [key]);
}
