import { Trans } from '@lingui/react/macro';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@src/components/ui/button';

/** The one question a received copy asks when the receiver already has it: replace it with the shared version. */
export function ReplacePrompt({ busy, onConfirm, testId }: { busy: boolean; onConfirm: () => void; testId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid={testId}>
      <span className="text-muted-foreground">
        <Trans>You already have this. Replace it with the shared version?</Trans>
      </span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={onConfirm} data-testid={`${testId}-confirm`}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        <Trans>Replace it</Trans>
      </Button>
    </div>
  );
}

/** The 409 an install answers when the asset is already there (``asset_conflict``). */
export function isAssetConflict(e: unknown): boolean {
  const res = (e as { response?: { status?: number; data?: { data?: { asset_conflict?: boolean } } } }).response;
  return res?.status === 409 && !!res.data?.data?.asset_conflict;
}
