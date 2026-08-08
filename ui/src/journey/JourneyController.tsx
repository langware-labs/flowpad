import { useEffect } from 'react';
import { setJourneyHighlight } from './journey-highlight';
import { useShownJourney } from './use-journey';
import { useJourneyManager } from './useJourneyManager';
import { JourneyTray } from './JourneyTray';

// Probe journeys are design-review content — they narrate our own open questions
// ("keep it, or drop it from Vibe entirely"), which is not something to render at
// a user. Dev-only, and dynamically imported so they leave the production bundle.
if (import.meta.env.DEV) void import('./probes');

/**
 * Mount point for the User Journey feature — one instance, near the top of the
 * app (App.tsx). Everything it renders is derived from `?journeyId=` in the URL,
 * so there is no in-memory journey state and a reload restores the tray exactly
 * where it was. The badge that shows/hides it lives in the left rail.
 */
export function JourneyController() {
  const state = useShownJourney();
  const view = useJourneyManager(state);

  // Publish the step's highlight instead of writing it to the URL. One writer,
  // cleared on unmount so a closed journey cannot leave a tag lit.
  const word = state.currentStep?.present.highlight ?? null;
  useEffect(() => {
    setJourneyHighlight(word);
    return () => setJourneyHighlight(null);
  }, [word]);

  return <JourneyTray state={state} view={view} />;
}
