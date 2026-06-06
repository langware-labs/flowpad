import type { CapabilityResult } from '@sdk';
import { capabilityManager } from '@sdk';
import { useCapability } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';

/**
 * "Install one of" capability picker.
 *
 * Opened when an interactive tab needs a harness but NO matching capability is
 * available on this machine. Lists the candidate capabilities (one row per
 * kind); clicking Install calls that capability's backend `install` action via
 * the capability manager and surfaces the result message inline.
 */
interface Props {
  /** Capability kinds to offer, or null when the dialog is closed. */
  kinds: string[] | null;
  onClose: () => void;
}

function installResultText(result: CapabilityResult | null | undefined): string | null {
  if (!result) return null;
  return result.message || (result.available ? 'Installed.' : 'Install did not complete.');
}

function CapabilityInstallRow({ kind }: { kind: string }) {
  const { capability, available, result } = useCapability(kind, { autoCheck: false });
  const [installing, setInstalling] = useState(false);
  const [installMessage, setInstallMessage] = useState<string | null>(null);

  const title = capability?.name ?? kind;
  const description = capability?.description ?? '';

  const onInstall = async () => {
    setInstalling(true);
    setInstallMessage(null);
    try {
      const snapshot = await capabilityManager.install(kind);
      setInstallMessage(installResultText(snapshot.result));
      // Re-check so availability (and any opener warnings) reflect the install.
      await capabilityManager.check(kind);
    } catch (error) {
      setInstallMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div
      className="flex items-start gap-3 rounded-md border p-3"
      data-testid={`install-one-of-row-${kind}`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{kind}</div>
        {description && <div className="mt-1 text-xs text-muted-foreground">{description}</div>}
        {(installMessage ?? result?.message) && (
          <div className="mt-1 text-xs text-amber-600 dark:text-amber-500">
            {installMessage ?? result?.message}
          </div>
        )}
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="shrink-0 gap-1.5"
        disabled={installing || available}
        onClick={() => void onInstall()}
        data-testid={`install-one-of-button-${kind}`}
      >
        {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        {available ? 'Installed' : 'Install'}
      </Button>
    </div>
  );
}

export function AskInstallOneOfDialog({ kinds, onClose }: Props) {
  return (
    <Dialog open={!!kinds?.length} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" data-testid="install-one-of-dialog">
        <DialogHeader>
          <DialogTitle>No harness available</DialogTitle>
          <DialogDescription>
            Starting this tab needs one of the following installed on this machine.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {(kinds ?? []).map((kind) => (
            <CapabilityInstallRow key={kind} kind={kind} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
