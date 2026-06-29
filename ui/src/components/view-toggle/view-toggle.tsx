import { ViewMode, setViewMode, useViewMode } from '@src/contexts/view-mode-context';

const LABELS: Record<ViewMode, string> = {
  [ViewMode.Standard]: 'Standard',
  [ViewMode.Advanced]: 'Advanced',
  [ViewMode.Dev]: 'Dev',
};

// 3-state cycle: Standard → Advanced → Dev → Standard (for developers in Dev mode)
const NEXT_3: Record<ViewMode, ViewMode> = {
  [ViewMode.Standard]: ViewMode.Advanced,
  [ViewMode.Advanced]: ViewMode.Dev,
  [ViewMode.Dev]: ViewMode.Standard,
};

// 2-state cycle: Standard ↔ Advanced (for normal users not in Dev mode)
const NEXT_2: Record<ViewMode, ViewMode> = {
  [ViewMode.Standard]: ViewMode.Advanced,
  [ViewMode.Advanced]: ViewMode.Standard,
  [ViewMode.Dev]: ViewMode.Advanced, // fallback, shouldn't be reached
};

/**
 * Footer text-pill toggle for the global view mode (Standard / Advanced / Dev).
 * Normal users see 2-state cycle (Standard ↔ Advanced).
 * Developers in Dev mode see 3-state cycle (Standard → Advanced → Dev → Standard).
 * Behaves like the theme toggle: flips a persisted, app-wide flag. Lives at the far left.
 */
export function ViewToggle() {
  const mode = useViewMode();
  // Show 3-state cycle only when already in Dev mode (developers know they're there)
  const isDev = mode === ViewMode.Dev;
  const nextMap = isDev ? NEXT_3 : NEXT_2;
  const next = nextMap[mode];

  return (
    <button
      type="button"
      data-testid="view-toggle"
      onClick={() => setViewMode(next)}
      className="flex h-6 min-w-[88px] items-center justify-center rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={`View: ${LABELS[mode]} — click for ${LABELS[next]}`}
      aria-label={`View mode: ${LABELS[mode]}`}
    >
      View: {LABELS[mode]}
    </button>
  );
}
