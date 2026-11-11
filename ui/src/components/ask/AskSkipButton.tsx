import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { SkipForward } from 'lucide-react';
import { Button } from '@src/components/ui/button';

/** What a question says once its step was skipped. */
export const SKIPPED = msg`Skipped — setup goes on without it.`;

/**
 * A setup question's way out (`skippable`): the step is skipped on this machine — the same skip its row in the
 * setup list offers, undone from there — and setup goes on without it, so the app opens on what is set up.
 */
export function AskSkipButton({ skippable, busy, onSkip }: { skippable?: boolean; busy: boolean; onSkip: () => void }) {
  if (!skippable) return null;
  return (
    <Button
      variant="link"
      size="sm"
      className="h-auto self-start gap-1 px-0 text-muted-foreground"
      data-testid="ask-skip"
      disabled={busy}
      onClick={onSkip}
    >
      <SkipForward className="size-3.5" />
      <Trans>Skip for now</Trans>
    </Button>
  );
}
