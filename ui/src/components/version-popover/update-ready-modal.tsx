import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { Trans } from '@lingui/react/macro';

/** What the shell staged in the background and now asks about ('update-ready'). */
export interface UpdateReadyInfo {
  /** 'engine': a flow SDK swap of a few seconds; 'both' / 'desktop': FlowPad restarts to install. */
  kind: 'engine' | 'both' | 'desktop';
  desktopVersion: string | null;
  engineVersion: string | null;
  /** The flow SDK is already downloaded too (false: it downloads right after the restart). */
  enginePrepared: boolean;
}

interface UpdateReadyModalProps {
  info: UpdateReadyInfo | null;
  busy: boolean;
  error: string | null;
  onRestartNow: () => void;
  onLater: () => void;
}

/**
 * "An update is available — update now or later?" Everything was downloaded, staged and checked while the
 * app kept working; this is the one question. "Later" is never "never": the next start of FlowPad runs the
 * new versions either way.
 */
export function UpdateReadyModal({ info, busy, error, onRestartNow, onLater }: UpdateReadyModalProps) {
  if (!info) return null;
  const versions = [
    info.desktopVersion ? `FlowPad ${info.desktopVersion}` : null,
    info.engineVersion ? `flow SDK ${info.engineVersion}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !busy) onLater();
      }}
    >
      <DialogContent className="max-w-sm" data-testid="update-ready-modal">
        <DialogHeader>
          <DialogTitle>
            <Trans>Update available</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-1 text-sm">
          <p>
            <Trans>A new version of FlowPad is available.</Trans>
          </p>
          <p className="text-muted-foreground" data-testid="update-ready-versions">
            {versions}
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onLater} disabled={busy} data-testid="update-ready-later-button">
            <Trans>Later</Trans>
          </Button>
          <Button type="button" onClick={onRestartNow} disabled={busy} data-testid="update-ready-now-button">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            <Trans>Update now</Trans>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
