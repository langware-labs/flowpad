import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import type { CloudSearchResult, ClaudeErrorRecord } from '@src/hooks/useClaudeErrorRecords';
import { CheckCircle2, Loader2, Search, Wrench } from 'lucide-react';
import { useState } from 'react';

export interface CloudSearchResultsModalProps {
  open: boolean;
  onClose: () => void;
  ignored: number;
  fixResults: CloudSearchResult[];
  /** Error records corresponding to fixResults (post-apply, have fix set). */
  fixErrors: ClaudeErrorRecord[];
  remaining: number;
  onFixAll: (fingerprints: string[]) => Promise<void>;
}

export function CloudSearchResultsModal({
  open,
  onClose,
  ignored,
  fixResults,
  fixErrors,
  remaining,
  onFixAll,
}: CloudSearchResultsModalProps) {
  const [isFixingAll, setIsFixingAll] = useState(false);
  const [fixedAll, setFixedAll] = useState(false);

  const fixableFingerprints = fixResults
    .filter((r) => r.instruction)
    .map((r) => r.fingerprint);

  const handleFixAll = async () => {
    setIsFixingAll(true);
    try {
      await onFixAll(fixableFingerprints);
      setFixedAll(true);
    } finally {
      setIsFixingAll(false);
    }
  };

  const totalFound = ignored + fixResults.length;
  const hasAnything = ignored > 0 || fixResults.length > 0 || remaining > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="h-4 w-4 text-blue-500" />
            Flowpad Cloud Results
          </DialogTitle>
        </DialogHeader>

        {!hasAnything && (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No matches found in the Flowpad known-issues database.
          </p>
        )}

        <div className="space-y-4">
          {/* Ignored / resolved */}
          {ignored > 0 && (
            <div className="flex items-center gap-3 rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
              <div>
                <p className="text-sm font-semibold text-green-400">
                  {ignored} issue{ignored !== 1 ? 's' : ''} resolved
                </p>
                <p className="text-xs text-muted-foreground">
                  These errors are known false positives.
                </p>
              </div>
            </div>
          )}

          {/* Fix suggestions */}
          {fixResults.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                  {fixResults.length} fix suggestion{fixResults.length !== 1 ? 's' : ''} available
                </p>
                {fixableFingerprints.length > 0 && !fixedAll && (
                  <Button
                    size="sm"
                    className="h-7 gap-1.5 bg-green-600 text-xs text-white hover:bg-green-500 hidden"
                    disabled={isFixingAll}
                    onClick={() => void handleFixAll()}
                  >
                    {isFixingAll
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <Wrench className="h-3 w-3" />
                    }
                    Fix All
                  </Button>
                )}
              </div>

              <div className="max-h-64 space-y-2 overflow-y-auto">
                {fixResults.map((r) => {
                  const error = fixErrors.find((e) => e.fingerprint === r.fingerprint);
                  return (
                    <div
                      key={r.fingerprint}
                      className="rounded-md border border-border bg-card p-3"
                    >
                      <div className="min-w-0 space-y-1">
                        <p className="truncate font-mono text-xs text-foreground/80">
                          {error?.error_msg ?? r.fingerprint}
                        </p>
                        {r.message && (
                          <p className="text-xs text-muted-foreground">{r.message}</p>
                        )}
                        {r.instruction && (
                          <p className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                            {r.instruction}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Remaining / needs investigation */}
          {remaining > 0 && (
            <div className="rounded-md border border-border bg-muted/30 px-4 py-3">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{remaining}</span>{' '}
                issue{remaining !== 1 ? 's' : ''} need investigation — no known fix yet.
              </p>
            </div>
          )}

          {totalFound === 0 && remaining === 0 && !hasAnything && null}
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
