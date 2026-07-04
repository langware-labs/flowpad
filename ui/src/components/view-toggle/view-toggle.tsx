import { ViewMode, setViewMode, useViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation';
import { ViewType } from '@src/types/ViewType';
import { useVibeWorkspaceSession } from '@src/pages/flow-page/use-vibe-workspace-session';

const LABELS: Record<ViewMode, string> = {
  [ViewMode.Vibe]: 'Vibe',
  [ViewMode.Standard]: 'Standard',
  [ViewMode.Advanced]: 'Advanced',
  [ViewMode.Dev]: 'Dev',
};

// Ordered cycles. Normal users wrap at Advanced; developers (already in Dev) also
// reach Dev before wrapping. One ordered list per ring — next = the entry after
// `mode`, wrapping to the start (and from any off-ring mode back to the first entry).
// Vibe leads each ring; it's dropped from the offered cycle off the agentic-process
// view (see `ring` below).
const RING_NORMAL: readonly ViewMode[] = [ViewMode.Vibe, ViewMode.Standard, ViewMode.Advanced];
const RING_DEV: readonly ViewMode[] = [...RING_NORMAL, ViewMode.Dev];

/**
 * Footer text-pill toggle for the global view mode (Vibe / Standard / Advanced / Dev).
 * Normal users cycle Vibe → Standard → Advanced → Vibe.
 * Developers in Dev mode also reach Dev (Vibe → Standard → Advanced → Dev → Vibe).
 * Vibe is not *offered* off the agentic-process view (it's the creator skin that
 * surface is built for), so the cycle collapses to Standard → Advanced (→ Dev) elsewhere.
 * Behaves like the theme toggle: flips a persisted, app-wide flag. Lives at the far left.
 */
export function ViewToggle() {
  const mode = useViewMode();
  const { currentDock, navigation } = useDockNavigation();
  // Offer Vibe in the cycle on the agentic-process view AND anywhere inside a
  // vibe workspace session (the display URL or one of its child tabs) — so the
  // toggle can still leave/re-enter vibe while browsing child tabs.
  const inWorkspace = !!useVibeWorkspaceSession();
  const onAgenticProcess = currentDock?.viewType === ViewType.AGENTIC_PROCESS || inWorkspace;
  // Include Dev in the cycle only when already in Dev mode (developers know they're there)
  const isDev = mode === ViewMode.Dev;
  const baseRing = isDev ? RING_DEV : RING_NORMAL;
  // Don't offer Vibe as a pick off the agentic-process view. When the persisted mode is
  // Vibe but we're off that view, `indexOf` returns -1 and `next` lands on the first ring
  // entry (Standard), lifting the user back out on click.
  const ring = onAgenticProcess ? baseRing : baseRing.filter((m) => m !== ViewMode.Vibe);
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
