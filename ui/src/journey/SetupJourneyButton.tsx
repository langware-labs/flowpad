import { useCallback, useState } from 'react';
import { Loader2, Compass } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { Journey } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** The shipped "Set up GitHub" journey (graph.json id — a stable v5 of
 *  "flowpad:journey:setup-github", minted backend-side). */
export const SETUP_GITHUB_JOURNEY_ID = 'e485cbde-7d23-5a7f-aaf0-852ecdf754bb';

/**
 * Launch-and-show for a capability-gated journey: POST launch (the backend
 * enforces the gate) and, when a journal comes back, put `?journeyId=` on the
 * current surface so the tray takes over. A refused launch (gate closed —
 * nothing left to set up) is a quiet no-op: the button's caller only renders
 * it while something is missing, so refusal is a stale-props race, not an
 * error the user needs to see.
 */
export function SetupJourneyButton({
  journeyId,
  size = 'sm',
  variant = 'outline',
  children,
}: {
  journeyId: string;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'default' | 'ghost';
  children?: React.ReactNode;
}) {
  const { navigation } = useDockNavigation();
  const [busy, setBusy] = useState(false);
  const launch = useCallback(async () => {
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
      disabled={busy}
      onClick={() => void launch()}
      className="h-7 gap-1.5 px-2.5 text-xs"
      data-testid={`setup-journey-${journeyId}`}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Compass className="h-3 w-3" />}
      {children ?? <Trans>Set up</Trans>}
    </Button>
  );
}
