import { ViewMode, setViewMode, useViewMode } from '@src/contexts/view-mode-context';

const cap = (m: ViewMode) => m[0].toUpperCase() + m.slice(1);

/**
 * Footer text-pill toggle for the global view mode (Standard / Advanced).
 * Behaves like the theme toggle: flips a persisted, app-wide flag that tunes
 * UI complexity down. Lives at the far left of the footer.
 */
export function ViewToggle() {
  const mode = useViewMode();
  const next = mode === ViewMode.Advanced ? ViewMode.Standard : ViewMode.Advanced;

  return (
    <button
      type="button"
      data-testid="view-toggle"
      onClick={() => setViewMode(next)}
      className="flex h-6 min-w-[88px] items-center justify-center rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={`View: ${cap(mode)} — click for ${cap(next)}`}
      aria-label={`View mode: ${cap(mode)}`}
    >
      View: {cap(mode)}
    </button>
  );
}
