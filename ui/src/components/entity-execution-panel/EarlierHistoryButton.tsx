import { AgenticProcess } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';

/** "Load earlier messages" above a chat that opened on the newest page of a long transcript. */
export function EarlierHistoryButton({ process }: { process: AgenticProcess }) {
  const [loading, setLoading] = useState(false);
  if (!process.hasEarlierHistory) return null;
  return (
    <div className="flex justify-center pb-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={loading}
        data-testid="load-earlier-history"
        onClick={() => {
          setLoading(true);
          void process.loadEarlierHistory().finally(() => setLoading(false));
        }}
      >
        {loading ? <Trans>Loading earlier messages…</Trans> : <Trans>Load earlier messages</Trans>}
      </Button>
    </div>
  );
}
