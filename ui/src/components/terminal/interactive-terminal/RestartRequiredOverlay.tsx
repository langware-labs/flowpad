/**
 * RestartRequiredOverlay — covers the terminal content area when flag changes
 * require a PTY restart.  Renders as an absolutely-positioned overlay inside
 * a `relative` parent (the terminal content container in TabbedTerminal).
 */

import { RotateCw } from 'lucide-react';
import { Button } from '@src/components/ui/button';

interface RestartRequiredOverlayProps {
  onRestart: () => void;
  onCancel: () => void;
  isRestarting: boolean;
}

export function RestartRequiredOverlay({ onRestart, onCancel, isRestarting }: RestartRequiredOverlayProps) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 rounded-lg border bg-card p-6 shadow-lg">
        <RotateCw className={`h-8 w-8 text-muted-foreground ${isRestarting ? 'animate-spin' : ''}`} />
        <div className="text-center">
          <h3 className="text-sm font-semibold">Restart Required</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Flag changes require a terminal restart to take effect.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={isRestarting}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onRestart}
            disabled={isRestarting}
          >
            {isRestarting ? (
              <>
                <RotateCw className="mr-1.5 h-3 w-3 animate-spin" />
                Restarting...
              </>
            ) : (
              'Restart'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
