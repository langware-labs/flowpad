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
 * "The update is ready — restart now or later?" Everything was downloaded and staged while the app kept
 * working; this is the one question. "Later" is never "never": the next start of FlowPad runs the new
 * versions either way.
 */
export function UpdateReadyModal({ info, busy, error, onRestartNow, onLater }: UpdateReadyModalProps) {
  if (!info) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !busy) onLater();
      }}
    >
      <DialogContent className="max-w-md" data-testid="update-ready-modal">
        <DialogHeader>
          <DialogTitle>
            {info.kind === 'engine' ? (
              <Trans>flow SDK v{info.engineVersion} is ready</Trans>
            ) : info.kind === 'both' ? (
              <Trans>FlowPad is ready to update</Trans>
            ) : (
              <Trans>FlowPad Desktop v{info.desktopVersion} is ready</Trans>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <p>
            {info.kind === 'engine' ? (
              <Trans>
                It was downloaded in the background. The engine restarts — this usually takes under a minute; FlowPad
                stays open.
              </Trans>
            ) : info.kind === 'both' ? (
              info.enginePrepared ? (
                <Trans>
                  FlowPad Desktop v{info.desktopVersion} and flow SDK v{info.engineVersion} are downloaded. FlowPad
                  restarts to install them.
                </Trans>
              ) : (
                <Trans>
                  FlowPad Desktop v{info.desktopVersion} is downloaded. FlowPad restarts to install it, and flow SDK v
                  {info.engineVersion} is installed right after.
                </Trans>
              )
            ) : (
              <Trans>It was downloaded in the background. FlowPad restarts to install it.</Trans>
            )}
          </p>
          <p className="text-muted-foreground">
            <Trans>Not now? The update is installed the next time FlowPad starts.</Trans>
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex flex-col gap-2">
          <Button type="button" onClick={onRestartNow} disabled={busy} data-testid="update-ready-now-button">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {info.kind === 'engine' ? <Trans>Restart the engine now</Trans> : <Trans>Restart now</Trans>}
          </Button>
          <Button type="button" variant="outline" onClick={onLater} disabled={busy} data-testid="update-ready-later-button">
            <Trans>Later</Trans>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
