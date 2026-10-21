import { Button } from '@src/components/ui/button';
import { Trans } from '@lingui/react/macro';
import { GitBranch, RefreshCw } from 'lucide-react';

/** The editor pane when a git-backed asset has no git link to read it from. */
export function GitConnectionRequiredCard({ name, onRetry }: { name: string; onRetry: () => void }) {
  return (
    <div className="flex h-full items-center justify-center" data-testid="asset-git-connection-required">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border bg-muted/30 p-6 text-sm">
        <GitBranch className="h-6 w-6 text-muted-foreground" />
        <div className="text-center">
          <div className="font-medium">
            <Trans>Git connection required</Trans>
          </div>
          <div className="mt-1 break-all text-xs text-muted-foreground">{name}</div>
          <div className="mt-2 text-xs text-muted-foreground">
            <Trans>
              Its files live in git, and it is not linked to a repository yet. Publish it from the FlowPad desktop app
              to view and edit it here.
            </Trans>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="me-1.5 h-3.5 w-3.5" />
          <Trans>Retry</Trans>
        </Button>
      </div>
    </div>
  );
}
