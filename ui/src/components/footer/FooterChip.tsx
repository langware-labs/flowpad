import type { ReactNode } from 'react';
import { ErrorBoundary } from '@src/components/error-boundary/error-boundary';

/** One footer item, on its own: a chip that throws disappears, the app and the other chips stay. */
export function FooterChip({ name, when = true, children }: { name: string; when?: boolean; children: ReactNode }) {
  if (!when) return null;
  return (
    <ErrorBoundary label={`footer ${name}`} fallback={null}>
      {children}
    </ErrorBoundary>
  );
}
