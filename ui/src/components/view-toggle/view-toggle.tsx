import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@src/components/ui/tooltip';
import { ViewMode, setViewMode, useViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation';
import { Code, FlaskConical, LayoutGrid, WandSparkles, type LucideIcon } from 'lucide-react';

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

// Buttons shown to everyone. Dev is appended only while already in Dev mode —
// developers know they're there; normal users never see it.
const MODES_NORMAL: readonly ViewMode[] = [ViewMode.Advanced, ViewMode.Standard, ViewMode.Vibe];
const MODES_DEV: readonly ViewMode[] = [...MODES_NORMAL, ViewMode.Dev];

/**
 * Footer segmented control for the global view mode (Advanced / Standard / Vibe,
 * plus Dev while in Dev). One icon button per mode, tooltip carries the name.
 * Behaves like the theme toggle: flips a persisted, app-wide flag. Lives at the far left.
 */
export function ViewToggle() {
  const mode = useViewMode();
  const { currentDock, navigation } = useDockNavigation();
  const modes = mode === ViewMode.Dev ? MODES_DEV : MODES_NORMAL;

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
