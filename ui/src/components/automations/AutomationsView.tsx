/**
 * The Automations dock: three places, picked by the URL (automations-pointer.ts).
 *
 *   list   — My automations, or one automation's page (`?trigger=`/`?creating=`)
 *   runs   — every run, one open on the right
 *   bus    — the event bus (Advanced)
 *
 * URL-first: what is shown is derived from `currentDock`; every click elsewhere
 * on the screen only calls `navigation.openDock`.
 */
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { AutomationPage } from './AutomationPage';
import { AutomationsList } from './AutomationsList';
import { parseAutomationsRoute } from './automations-pointer';
import { BusView } from './BusView';
import { RunsView } from './RunsView';

export function AutomationsView() {
  const { currentDock } = useDockNavigation();
  const route = parseAutomationsRoute(currentDock?.pointer, currentDock?.options);

  if (route.place === 'runs') return <RunsView route={route} />;
  if (route.place === 'bus') return <BusView route={route} />;
  if (route.trigger || route.creating)
    return <AutomationPage key={route.trigger ?? `new-${route.creating}`} route={route} />;
  return <AutomationsList />;
}
