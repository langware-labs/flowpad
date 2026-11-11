import { useCallback, useState } from 'react';
import { Loader2, Compass } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { Journey } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useJourneys } from './use-journey';

/** The shipped "Set up GitHub" journey, named by its asset folder. A journey's id
 *  is minted per install (its identity capsule is not shipped), so it is looked up
 *  by this name, never hardcoded. */
export const SETUP_GITHUB_JOURNEY = 'setup-github';

/**
 * Launch-and-show for a capability-gated journey: POST launch (the backend
 * enforces the gate) and, when a journal comes back, put `?journeyId=` on the
 * current surface so the tray takes over. A refused launch (gate closed —
 * nothing left to set up) is a quiet no-op: the button's caller only renders
 * it while something is missing, so refusal is a stale-props race, not an
 * error the user needs to see.
 */
export function SetupJourneyButton({
  journey,
  size = 'sm',
  variant = 'outline',
  children,
}: {
  journey: string;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'default' | 'ghost';
  children?: React.ReactNode;
}) {
  const { navigation } = useDockNavigation();
  const [busy, setBusy] = useState(false);
  const { data: journeys } = useJourneys();
  const journeyId = journeys?.find((j) => j.asset_ref?.split(/[\\/]/).pop() === journey)?.id;
  const launch = useCallback(async () => {
    if (!journeyId) return;
    setBusy(true);
    try {
      const journal = await new Journey({ id: journeyId }).launch();
      if (journal) navigation.showJourney(journeyId);
    } finally {
      setBusy(false);
    }
  }, [journeyId, navigation]);
  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      disabled={busy || !journeyId}
      onClick={() => void launch()}
      className="h-7 gap-1.5 px-2.5 text-xs"
      data-testid={`setup-journey-${journey}`}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Compass className="h-3 w-3" />}
      {children ?? <Trans>Set up</Trans>}
    </Button>
  );
}
