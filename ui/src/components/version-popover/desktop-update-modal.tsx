import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { Trans } from '@lingui/react/macro';

/** What the "Desktop Update Required" popup needs to say (FLOWPAD-2310). */
export interface DesktopUpdateRequiredInfo {
  /** The flow SDK (PyPI) version the user tried to install. */
  engineTarget: string;
  /** That release's minimum desktop version, when known. */
  minDesktop: string | null;
  /** The running desktop app's version. */
  desktopInstalled: string | null;
  /** The newer desktop build on the update feed, or null when none is published yet. */
  desktopAvailable: string | null;
}

interface DesktopUpdateModalProps {
  open: boolean;
  info: DesktopUpdateRequiredInfo | null;
  busy: boolean;
  error: string | null;
  /** Update the desktop now and the named engine version right after the restart. */
  onUpdateBoth: () => void;
  /** Update the desktop only; the engine stays as installed. */
  onDesktopOnly: () => void;
  onClose: () => void;
}

/**
 * The in-app popup shown when an engine (PyPI) upgrade needs a newer desktop first.
 * Everything happens inside the app: no external download pages, no other screens.
 */
export function DesktopUpdateModal({ open, info, busy, error, onUpdateBoth, onDesktopOnly, onClose }: DesktopUpdateModalProps) {
  if (!info) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-md" data-testid="desktop-update-required-modal">
        <DialogHeader>
          <DialogTitle>
            <Trans>Desktop Update Required</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <p>
            {info.minDesktop ? (
              <Trans>
                flow SDK v{info.engineTarget} requires FlowPad Desktop {info.minDesktop} or newer — you have v
                {info.desktopInstalled ?? '?'}.
              </Trans>
            ) : (
              <Trans>A newer version of FlowPad Desktop is required before upgrading the Python backend.</Trans>
            )}
          </p>
          {info.desktopAvailable ? (
            <p className="text-muted-foreground">
              <Trans>
                FlowPad Desktop v{info.desktopAvailable} is available. We can update both components automatically, or
                you can update FlowPad Desktop only.
              </Trans>
            </p>
          ) : (
            <p className="text-muted-foreground">
              <Trans>
                No newer FlowPad Desktop build is available yet, so this backend version cannot be installed. Your
                current installation is unchanged — check again after the next desktop release.
              </Trans>
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex flex-col gap-2">
          {info.desktopAvailable && (
            <>
              <Button type="button" onClick={onUpdateBoth} disabled={busy} data-testid="update-both-button">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <Trans>Update Both (Recommended)</Trans>
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={onDesktopOnly}
                disabled={busy}
                data-testid="update-desktop-only-button"
              >
                <Trans>Update Desktop Only</Trans>
              </Button>
            </>
          )}
          <Button type="button" variant="outline" onClick={onClose} disabled={busy} data-testid="update-cancel-button">
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
