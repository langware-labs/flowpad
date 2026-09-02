import * as React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { KeyRound } from 'lucide-react';
import type { CredentialSpec, OAuthProvider } from '@sdk';
import { lucideByName } from '@src/lib/lucide-by-name';
import { isLucideName } from '@src/lib/icon-value';
import { DesktopTile, TileSection } from '@src/components/quick-create/QuickCreatePanel';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';

/**
 * The connection catalogue, as tiles.
 *
 * The table lists what EXISTS; everything you could add lives here — the same
 * split the desktop makes between your files and "New …".
 *
 * `DesktopTile` and `TileSection` are the project-home tiles, imported rather
 * than restyled: they are exported precisely "so sibling surfaces present the
 * same shape rather than inventing a second look for the same kind of act", and
 * adding a connection is the same kind of act as adding an asset.
 */
export interface AddConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** OAuth providers with no credential held yet. */
  providers: OAuthProvider[];
  /** Credential definitions with nothing declared or detected yet. */
  specs: CredentialSpec[];
  onPickProvider: (providerName: string) => void;
  onPickCredential: (spec: CredentialSpec) => void;
  /** Set while a pick is in flight, so the tile can spell "working". */
  busyKey?: string | null;
}

/** A credential definition's glyph — `icon_name` is asset data, not a TYPE
 *  icon, so `iconForType` is the wrong registry here. */
function specIcon(iconName?: string) {
  return isLucideName(iconName) ? lucideByName(iconName) : KeyRound;
}

export function AddConnectionDialog({
  open,
  onOpenChange,
  providers,
  specs,
  onPickProvider,
  onPickCredential,
  busyKey,
}: AddConnectionDialogProps) {
  const { t } = useLingui();
  const nothingLeft = providers.length === 0 && specs.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="add-connection-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add connection</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Values stay on this machine. Nothing is sent anywhere by adding one.</Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {providers.length > 0 && (
            <TileSection title={<Trans>Sign in with a provider</Trans>}>
              {providers.map((p) => {
                const Icon = specIcon(p.icon);
                return (
                  <DesktopTile
                    key={p.name}
                    Icon={Icon}
                    label={p.display_name || p.name}
                    loading={busyKey === p.name}
                    data-testid={`add-connection-${p.name}`}
                    onClick={() => onPickProvider(p.name)}
                  />
                );
              })}
            </TileSection>
          )}

          {specs.length > 0 && (
            <TileSection title={<Trans>Use an API key</Trans>}>
              {specs.map((spec) => (
                <DesktopTile
                  key={spec.name}
                  Icon={specIcon(spec.icon_name)}
                  label={spec.title || String(spec.name ?? '')}
                  loading={busyKey === spec.name}
                  data-testid={`add-connection-${spec.name}`}
                  onClick={() => onPickCredential(spec)}
                />
              ))}
            </TileSection>
          )}

          {nothingLeft && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              <Trans>Everything available is already connected.</Trans>
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
