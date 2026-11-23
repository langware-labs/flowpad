import type { ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronRight } from 'lucide-react';

/** The pieces of a status card on a message (a diagnosis, what an automation posted): a label and its
 *  value in a line, the Details toggle, and the folded rows it opens. */
export function CardLine({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-20 shrink-0 text-muted-foreground">{name}</span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}

export function DetailsToggle({ open, onToggle, testId }: { open: boolean; onToggle: () => void; testId: string }) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      onClick={onToggle}
      aria-expanded={open}
      data-testid={testId}
    >
      {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      {t`Details`}
    </button>
  );
}

export function DetailsList({ rows, testId }: { rows: [string, ReactNode][]; testId: string }) {
  return (
    <dl className="break-words rounded-md border bg-muted/30 px-2.5 py-2 text-xs" data-testid={testId}>
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="mb-1 last:mb-0">
            <dt className="font-medium text-foreground">{k}</dt>
            <dd className="whitespace-pre-wrap text-muted-foreground">{v}</dd>
          </div>
        ))}
    </dl>
  );
}
