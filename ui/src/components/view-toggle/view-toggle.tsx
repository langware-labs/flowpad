import { ViewMode, setViewMode, useViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation';

const LABELS: Record<ViewMode, string> = {
  [ViewMode.Vibe]: 'Vibe',
  [ViewMode.Standard]: 'Standard',
  [ViewMode.Advanced]: 'Advanced',
  [ViewMode.Dev]: 'Dev',
};

// Ordered cycles. Normal users wrap at Advanced; developers (already in Dev) also
// reach Dev before wrapping. One ordered list per ring — next = the entry after
// `mode`, wrapping to the start (and from any off-ring mode back to the first entry).
// Vibe leads each ring and is offered everywhere: it's a full app skin with its
// own home (VibeHome), not just the agentic-process creator surface.
const RING_NORMAL: readonly ViewMode[] = [ViewMode.Vibe, ViewMode.Standard, ViewMode.Advanced];
const RING_DEV: readonly ViewMode[] = [...RING_NORMAL, ViewMode.Dev];

/**
 * Footer text-pill toggle for the global view mode (Vibe / Standard / Advanced / Dev).
 * Normal users cycle Vibe → Standard → Advanced → Vibe.
 * Developers in Dev mode also reach Dev (Vibe → Standard → Advanced → Dev → Vibe).
 * Behaves like the theme toggle: flips a persisted, app-wide flag. Lives at the far left.
 */
export function ViewToggle() {
  const mode = useViewMode();
  const { currentDock, navigation } = useDockNavigation();
  // Include Dev in the cycle only when already in Dev mode (developers know they're there)
  const isDev = mode === ViewMode.Dev;
  const ring = isDev ? RING_DEV : RING_NORMAL;
  const next = ring[(ring.indexOf(mode) + 1) % ring.length];

  return (
    <button
      type="button"
      data-testid="view-toggle"
      onClick={() => {
        if (currentDock?.viewMode) {
          navigation.openDock(currentDock.withViewMode(next));
        } else {
          setViewMode(next);
        }
      }}
      className="flex h-6 min-w-[88px] items-center justify-center rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={`View: ${LABELS[mode]} — click for ${LABELS[next]}`}
      aria-label={`View mode: ${LABELS[mode]}`}
    >
      View: {LABELS[mode]}
    </button>
  );
}
