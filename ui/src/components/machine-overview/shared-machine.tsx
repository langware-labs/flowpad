import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { ExternalLink, Server } from 'lucide-react';
import { cloudManager, type ComputeNode } from '@sdk';
import { Button } from '@src/components/ui/button';
import { isLaunched, readSandboxStatus, type SandboxDetails } from '@src/hooks/use-sandboxes';
import { isOperable } from '@src/pages/hub-home/machine-status';
import { SandboxStatus } from '@src/pages/hub-home/HubHome';
import { hubPageUrl } from '@src/lib/hub-page-url';

/**
 * A machine someone shared with you. It runs on the hub's side, so this machine's processes, ports and
 * secrets are not the thing to show: its name, its state as the hub reads it, and the way in — the hub's
 * sandbox landing, which signs you in and opens it (the same door the share email and the Machines card use).
 */
export function SharedMachine({ node }: { node: ComputeNode }) {
  const { t } = useLingui();
  const [status, setStatus] = useState<SandboxDetails | null>(null);
  useEffect(() => {
    let alive = true;
    void readSandboxStatus(node).then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
    // Keyed on the machine, not the row object: every push of the row would re-probe the hub.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const openUrl = hubPageUrl(cloudManager.cloudAppUrl, node.typeId);
  const launched = isLaunched(node);
  return (
    <div className="flex h-full w-full items-start justify-center p-8" data-testid="shared-machine">
      <div className="flex w-full max-w-xl items-center gap-4 rounded-lg border border-border bg-muted/20 p-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          <Server className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-medium" data-testid="shared-machine-name">
            {node.name || t`Machine`}
          </div>
          <div className="text-xs text-muted-foreground">
            <Trans>Shared with you</Trans>
          </div>
          <div data-testid="shared-machine-state">
            <SandboxStatus info={status ?? undefined} now={Date.now()} launched={launched} />
          </div>
        </div>
        <Button
          size="sm"
          disabled={!openUrl}
          title={!openUrl ? t`Sign in to Flowpad Cloud to open it` : undefined}
          onClick={() => openUrl && window.open(openUrl, '_blank')}
          data-testid="shared-machine-open"
          variant={launched && isOperable(status ?? undefined) ? 'default' : 'outline'}
        >
          <ExternalLink className="me-1 h-3.5 w-3.5" />
          <Trans>Open workspace</Trans>
        </Button>
      </div>
    </div>
  );
}
