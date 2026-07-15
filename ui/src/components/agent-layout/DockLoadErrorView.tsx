import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation';
import type { DockLoadErrorEntry } from '@src/routes/loaders/dock-load-error-store';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface DockLoadErrorViewProps {
  error: DockLoadErrorEntry;
}

export function DockLoadErrorView({ error }: DockLoadErrorViewProps) {
  const { navigation } = useDockNavigation();

  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="dock-load-error-view">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border bg-muted/30 p-6 text-center text-sm">
        <AlertTriangle className="h-7 w-7 text-destructive" />
        <div>
          <h2 className="text-base font-semibold text-foreground">{error.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
        </div>
        {error.retryable || error.link ? (
          <div className="flex items-center gap-2">
            {error.retryable ? (
              <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
                Retry
              </Button>
            ) : null}
            {error.link ? (
              <Button
                size="sm"
                variant="outline"
                data-testid="dock-load-error-link"
                onClick={() => navigation.openDock(error.link!.pointer)}
              >
                {error.link.label}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

