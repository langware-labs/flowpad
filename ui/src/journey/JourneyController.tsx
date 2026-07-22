import { useShownJourney } from './use-journey';
import { useJourneyManager } from './useJourneyManager';
import { JourneyTray } from './JourneyTray';

/**
 * Mount point for the User Journey feature — one instance, near the top of the
 * app (App.tsx). Everything it renders is derived from `?journeyId=` in the URL,
 * so there is no in-memory journey state and a reload restores the tray exactly
 * where it was. The badge that shows/hides it lives in the left rail.
 */
export function JourneyController() {
  const state = useShownJourney();
  useJourneyManager(state);
  return <JourneyTray state={state} />;
}
