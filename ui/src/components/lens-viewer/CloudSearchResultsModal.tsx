import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import type { CloudSearchResult, ClaudeErrorRecord } from '@src/hooks/useClaudeErrorRecords';
import { CheckCircle2, Loader2, Search, Wrench, AlertCircle } from 'lucide-react';
import { useState } from 'react';
import { Trans } from '@lingui/react/macro';

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

  const totalResolved = ignored + fixResults.length;
  const totalScanned = totalResolved + remaining;
  const hasAnything = ignored > 0 || fixResults.length > 0 || remaining > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="h-4 w-4 text-blue-400" />
            <Trans>Flowpad Cloud Results</Trans>
          </DialogTitle>
        </DialogHeader>

        {!hasAnything && (
          <p className="py-4 text-center text-sm text-muted-foreground">
            <Trans>No matches found in the Flowpad known-issues database.</Trans>
          </p>
        )}

        {hasAnything && (
          <div className="space-y-4">
            {/* Summary banner */}
            <div className="rounded-lg border border-border bg-gradient-to-r from-blue-500/5 via-transparent to-green-500/5 px-4 py-3">
              <p className="text-sm">
                <Trans>Scanned <span className="font-semibold text-foreground">{totalScanned}</span> open issue{totalScanned !== 1 ? 's' : ''} against the known-issues database.</Trans>
              </p>
              {totalResolved > 0 && (
                <p className="mt-1 text-xs text-green-400">
                  <Trans>{totalResolved} issue{totalResolved !== 1 ? 's' : ''} matched — saving you the time to debug {totalResolved !== 1 ? 'them' : 'it'} manually.</Trans>
                </p>
              )}
            </div>

            {/* Ignored / resolved */}
            {ignored > 0 && (
              <div className="flex items-center gap-3 rounded-lg border border-green-500/20 bg-green-500/5 px-4 py-3">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
                <div>
                  <p className="text-sm font-semibold text-green-400">
                    <Trans>{ignored} issue{ignored !== 1 ? 's' : ''} auto-resolved</Trans>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <Trans>Known false positives — marked as ignored.</Trans>
                  </p>
                </div>
              </div>
            )}

            {/* Fix suggestions */}
            {fixResults.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Wrench className="h-4 w-4 text-amber-400" />
                    <p className="text-sm font-semibold">
                      <Trans>{fixResults.length} fix{fixResults.length !== 1 ? 'es' : ''} available</Trans>
                    </p>
                  </div>
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
                      <Trans>Fix All</Trans>
                    </Button>
                  )}
                </div>

                <div className="max-h-64 space-y-2 overflow-y-auto">
                  {fixResults.map((r) => {
                    const error = fixErrors.find((e) => e.fingerprint === r.fingerprint);
                    return (
                      <div
                        key={r.fingerprint}
                        className="rounded-lg border border-border bg-card p-3"
                      >
                        <p className="truncate font-mono text-xs text-foreground/80">
                          {error?.error_msg ?? r.fingerprint}
                        </p>
                        {r.message && (
                          <p className="mt-1.5 text-xs font-medium text-blue-400">{r.message}</p>
                        )}
                        {r.instruction && (
                          <div className="mt-1.5 rounded-md border border-blue-500/20 bg-blue-500/5 px-2.5 py-1.5">
                            <p className="text-xs text-muted-foreground">{r.instruction}</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Remaining / needs investigation */}
            {remaining > 0 && (
              <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
                <AlertCircle className="h-5 w-5 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-sm text-foreground">
                    <Trans>{remaining} issue{remaining !== 1 ? 's' : ''} need investigation</Trans>
                  </p>
                  <p className="text-xs text-muted-foreground"><Trans>No known fix yet — use "Fix It" to start a session.</Trans></p>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end pt-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            <Trans>Close</Trans>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
