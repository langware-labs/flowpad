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
  /** True when the update feed could not be checked at all (offline / feed error) — different
   *  advice than "no newer build is published": try again, rather than wait for a release. */
  checkFailed?: boolean;
  /** The newest flow SDK THIS desktop can run — the popup's fallback when no suitable desktop
   *  build is published yet. Null when none, or when it would not move the install forward. */
  newestCompatible?: string | null;
}

interface DesktopUpdateModalProps {
  open: boolean;
  info: DesktopUpdateRequiredInfo | null;
  busy: boolean;
  error: string | null;
  /** Update the desktop now and the named engine version right after the restart. */
  onUpdateBoth: () => void;
  /** Install `newestCompatible` on the CURRENT desktop (no desktop update involved). */
  onUpgradeCompatible?: () => void;
  onClose: () => void;
}

/**
 * The in-app popup shown when an engine (PyPI) upgrade needs a newer desktop first.
 * Everything happens inside the app: no external download pages, no other screens.
 * One way forward: a desktop update never leaves the engine behind, so the only
 * update action is Update Both — there is no "desktop only".
 */
export function DesktopUpdateModal({ open, info, busy, error, onUpdateBoth, onUpgradeCompatible, onClose }: DesktopUpdateModalProps) {
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
                FlowPad Desktop v{info.desktopAvailable} is available. Both components update together: the desktop
                first, then the flow SDK right after the restart.
              </Trans>
            </p>
          ) : info.checkFailed ? (
            <p className="text-muted-foreground">
              <Trans>
                The desktop update feed could not be checked, so this backend version cannot be installed right now.
                Your current installation is unchanged — check your connection and try again.
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
            <Button type="button" onClick={onUpdateBoth} disabled={busy} data-testid="update-both-button">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              <Trans>Update Both</Trans>
            </Button>
          )}
          {!info.desktopAvailable && !info.checkFailed && info.newestCompatible && onUpgradeCompatible && (
            <Button
              type="button"
              onClick={onUpgradeCompatible}
              disabled={busy}
              data-testid="update-compatible-button"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              <Trans>Update flow SDK to v{info.newestCompatible} (works with this desktop)</Trans>
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose} disabled={busy} data-testid="update-cancel-button">
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
