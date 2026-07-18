import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@src/components/ui/tooltip';
import { ViewMode, setViewMode, useViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation';
import { Code, FlaskConical, LayoutGrid, WandSparkles, type LucideIcon } from 'lucide-react';
import { useState } from 'react';

const LABELS: Record<ViewMode, string> = {
  [ViewMode.Vibe]: 'Vibe',
  [ViewMode.Standard]: 'Standard',
  [ViewMode.Advanced]: 'Advanced',
  [ViewMode.Dev]: 'Dev',
};

const ICONS: Record<ViewMode, LucideIcon> = {
  [ViewMode.Vibe]: WandSparkles,
  [ViewMode.Standard]: LayoutGrid,
  [ViewMode.Advanced]: Code,
  [ViewMode.Dev]: FlaskConical,
};

// Mode hierarchy, simplest → fullest. Rank = index.
const HIERARCHY = [ViewMode.Vibe, ViewMode.Standard, ViewMode.Advanced, ViewMode.Dev] as const;
const rank = (m: ViewMode) => HIERARCHY.indexOf(m);

// Visual order of the segmented control: fullest → simplest, so newly revealed
// modes grow to the LEFT. Which of these actually render is decided per render.
const DISPLAY_ORDER = [ViewMode.Dev, ViewMode.Advanced, ViewMode.Standard, ViewMode.Vibe] as const;

// The next mode up the hierarchy, revealed by double-clicking the SELECTED
// button: Standard unlocks Advanced, Advanced unlocks Dev. Vibe/Dev unlock nothing.
const NEXT: Partial<Record<ViewMode, ViewMode>> = {
  [ViewMode.Standard]: ViewMode.Advanced,
  [ViewMode.Advanced]: ViewMode.Dev,
};

// Module scope so a reveal survives footer remounts across navigations;
// intentionally NOT persisted — a reload hides Advanced/Dev again.
let sessionRevealed: ReadonlySet<ViewMode> = new Set();

/** Test-only: forget double-click reveals between test cases. */
export function resetRevealedModes() {
  sessionRevealed = new Set();
}

/**
 * Footer segmented control for the global view mode. Normally offers only
 * Vibe/Standard; the higher modes are hidden until unlocked — double-clicking
 * the selected Standard button reveals Advanced, double-clicking the selected
 * Advanced button reveals Dev (revealing never selects). Every mode at or below
 * the current one always renders, so landing in Advanced/Dev (persisted pref or
 * URL override) can't hide the selected button. One icon button per mode,
 * tooltip carries the name. Lives at the far left.
 */
export function ViewToggle() {
  const mode = useViewMode();
  const { currentDock, navigation } = useDockNavigation();
  const [revealed, setRevealed] = useState(sessionRevealed);
  const reveal = (m: ViewMode) => {
    sessionRevealed = new Set([...sessionRevealed, m]);
    setRevealed(sessionRevealed);
  };
  const modes = DISPLAY_ORDER.filter(
    (m) => rank(m) <= rank(ViewMode.Standard) || revealed.has(m) || rank(m) <= rank(mode),
  );

  // URL-first: the click only navigates — same pointer, requested mode. All
  // arrangements (applying + persisting the mode) happen on load, driven by the
  // URL (useDockViewModeOverrideSync). Pointerless routes (e.g. home) have no
  // dock URL to carry the mode, so they write the preference directly.
  const select = (next: ViewMode) => {
    if (next === mode) return;
    if (currentDock) {
      navigation.openDock(currentDock.withViewMode(next));
    } else {
      setViewMode(next);
    }
  };

  return (
    <TooltipProvider>
      <div
        data-testid="view-toggle"
        role="radiogroup"
        aria-label="View mode"
        className="flex h-6 items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5"
      >
      {modes.map((m) => {
        const Icon = ICONS[m];
        const active = m === mode;
        return (
          <Tooltip key={m} delayDuration={0}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`view-toggle-${LABELS[m].toLowerCase()}`}
                onClick={() => select(m)}
                // Reveal-only: adds the next mode's button, never selects it.
                // No dblclick/click disambiguation needed — the two preceding
                // clicks hit select(m) with m === mode, which early-returns.
                onDoubleClick={() => {
                  if (m !== mode) return;
                  const next = NEXT[m];
                  if (next) reveal(next);
                }}
                className={`flex h-5 w-6 items-center justify-center rounded-sm transition-colors ${
                  active
                    ? 'bg-accent text-primary ring-1 ring-primary/40'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                }`}
                aria-label={LABELS[m]}
              >
                <Icon className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{LABELS[m]}</TooltipContent>
          </Tooltip>
        );
      })}
      </div>
    </TooltipProvider>
  );
}
