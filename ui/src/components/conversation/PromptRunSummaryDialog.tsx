import { Trans } from '@lingui/react/macro';
import type { PromptRunSummary } from '@sdk';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';

interface PromptRunSummaryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whose machine ran it. */
  host: string;
  prompt: string | null;
  summary: PromptRunSummary;
  answer: string | null;
}

const LABEL = 'mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
const BLOCK = 'whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs text-foreground';

/**
 * The sender's read-only view of the run that answered their prompt: the prompt, each
 * step (a tool, and the file it worked on), the files it changed, and the answer.
 * The host's transcript stays on the host — this is all that was sent back.
 */
export function PromptRunSummaryDialog({ open, onOpenChange, host, prompt, summary, answer }: PromptRunSummaryDialogProps) {
  const steps = summary.steps ?? [];
  const files = summary.files_touched ?? [];
  const more = summary.more ?? 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="prompt-run-summary">
        <DialogHeader>
          <DialogTitle>
            <Trans>Run on {host}'s machine</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-auto">
          {prompt && (
            <section>
              <h3 className={LABEL}>
                <Trans>Prompt</Trans>
              </h3>
              <pre className={`${BLOCK} font-mono`}>{prompt}</pre>
            </section>
          )}
          <section>
            <h3 className={LABEL}>
              <Trans>Steps</Trans>
            </h3>
            {steps.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <Trans>It answered without using any tool.</Trans>
              </p>
            ) : (
              <ol className="space-y-1 text-xs" data-testid="prompt-run-steps">
                {steps.map((step, i) => (
                  <li key={i} className="flex items-baseline gap-2">
                    <span className="w-5 shrink-0 text-end tabular-nums text-muted-foreground">{i + 1}</span>
                    <span className="shrink-0 font-medium text-foreground">{step.tool}</span>
                    {step.path && <span className="min-w-0 break-all font-mono text-muted-foreground">{step.path}</span>}
                  </li>
                ))}
              </ol>
            )}
            {more > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                <Trans>and {more} more</Trans>
              </p>
            )}
          </section>
          {files.length > 0 && (
            <section>
              <h3 className={LABEL}>
                <Trans>Files changed</Trans>
              </h3>
              <ul className="space-y-0.5 font-mono text-xs text-foreground" data-testid="prompt-run-files">
                {files.map((f) => (
                  <li key={f} className="break-all">
                    {f}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {answer && (
            <section>
              <h3 className={LABEL}>
                <Trans>Answer</Trans>
              </h3>
              <div className={`${BLOCK} text-sm`}>{answer}</div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
