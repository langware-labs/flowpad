import { useEffect } from 'react';
import { create } from 'zustand';
import { Trans } from '@lingui/react/macro';
import { Minimize2 } from 'lucide-react';

/**
 * Whether the content area fills the whole window. Presentation only: which tab
 * is shown stays the URL's business — this just hides the chrome around it.
 * Not FullScreenView: that portals its children, which would remount the tab.
 */
export const useTabFullScreen = create<{ on: boolean }>(() => ({ on: false }));

export const setTabFullScreen = (on: boolean) => useTabFullScreen.setState({ on });

/** The Exit button over a full-screen content area; Esc exits too while it is mounted. */
export function TabFullScreenExit() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setTabFullScreen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <button
      type="button"
      onClick={() => setTabFullScreen(false)}
      className="absolute end-2 top-2 z-[60] flex items-center gap-1 rounded-md border border-border bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm hover:text-foreground"
      data-testid="tab-full-screen-exit"
    >
      <Minimize2 className="h-3.5 w-3.5" aria-hidden />
      <Trans>Exit full screen</Trans>
      <kbd className="ms-1 rounded border border-border px-1 text-[10px]">Esc</kbd>
    </button>
  );
}
