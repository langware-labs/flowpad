import type { ReactNode } from 'react';
import { XCircle } from 'lucide-react';

/** An error, readable on the dark theme: a tinted row with a red edge, the text in the foreground colour. */
export function ErrorLine({ error, testId }: { error: ReactNode; testId?: string }) {
  if (!error) return null;
  return (
    <p
      className="flex items-start gap-1.5 rounded-sm border-l-2 border-red-500 bg-red-500/15 px-2 py-1 text-xs text-foreground"
      data-testid={testId}
    >
      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" aria-hidden />
      <span className="min-w-0">{error}</span>
    </p>
  );
}
