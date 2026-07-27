import { Compass } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { clearJourneyDismissed, markJourneyDismissed } from './journey-dismissed';
import { useActiveJourneyId } from './use-active-journey-id';
import { useActiveJournal } from './use-journey';

/**
 * A glowing pill in the left rail surfacing the in-progress journey and how many
 * steps remain. Driven by SERVER state (the active journal), so it persists
 * across reloads and keeps offering a way back after the tray is closed.
 *
 * Clicking toggles the journey on the URL — `showJourney` sets `?journeyId=`
 * (which opens the tray and resumes orchestration), `closeJourney` clears it.
 */
export function JourneyBadge() {
  const { t } = useLingui();
  const { journal, journeyId } = useActiveJournal();
  const shownId = useActiveJourneyId();
  const { navigation } = useDockNavigation();

  if (!journal || !journeyId) return null;

  const shown = shownId === journeyId;
  const stepsLeft = journal.steps_left ?? 0;
  const label = shown
    ? t`Hide the guided journey`
    : t`Getting started — ${stepsLeft} steps left`;

  return (
    <button
      type="button"
      onClick={() => {
        // Dismissed bookkeeping lives HERE (journey layer), not in the nav
        // core: the flag's one consumer is the journey auto-launch redirect.
        if (shown) {
          markJourneyDismissed();
          navigation.closeJourney();
        } else {
          clearJourneyDismissed();
          navigation.showJourney(journeyId);
        }
      }}
      title={label}
      aria-label={label}
      aria-pressed={shown}
      data-testid="journey-badge"
      data-minimize-anchor="journey-badge"
      className={cn(
        'relative flex h-8 w-8 items-center justify-center rounded-full',
        'text-white ring-1 transition-transform hover:scale-105',
        'focus-visible:outline-none focus-visible:ring-2',
        shown ? 'ring-white/40' : 'shadow-[0_0_10px_2px_rgba(246,167,35,0.55)] motion-safe:animate-pulse',
      )}
      style={{ backgroundColor: '#5b5bf0', borderColor: '#f6a723' }}
    >
      <Compass className="h-4 w-4" aria-hidden />
      {stepsLeft > 0 && (
        <span
          className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-black"
          style={{ backgroundColor: '#f6a723' }}
          data-testid="journey-badge-count"
        >
          {stepsLeft}
        </span>
      )}
    </button>
  );
}
