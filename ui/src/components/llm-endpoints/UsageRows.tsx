/**
 * The one row both usage breakdown tables render — the endpoint detail's
 * by-child table and the token plan's "Who's spending". Name cell first, then
 * whatever numbers that table shows, mono and end-aligned. A row with an `id`
 * is a drill-down into that endpoint's Usage tab, which is how spend is
 * followed down a chain; the "direct" bucket and model rows have none.
 */
import type { ReactNode } from 'react';

import { TableCell, TableRow } from '@src/components/ui/table';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

import { openLlmEndpoint } from './llm-endpoints-pointer';

export interface UsageChildRowProps {
  /** Bare endpoint uuid; null for a row that is not an endpoint. */
  id: string | null;
  label: ReactNode;
  /** Rendered right after the label, e.g. "(you)". */
  suffix?: ReactNode;
  testId: string;
  /** One cell per column after the name, in order. */
  values: readonly ReactNode[];
}

export function UsageChildRow({ id, label, suffix, testId, values }: UsageChildRowProps) {
  const { navigation } = useDockNavigation();
  return (
    <TableRow
      data-testid={testId}
      className={id ? 'cursor-pointer' : undefined}
      onClick={id ? () => openLlmEndpoint(navigation, id, 'usage') : undefined}
    >
      <TableCell className={id ? 'font-medium underline-offset-2 hover:underline' : ''}>
        {label}
        {suffix}
      </TableCell>
      {values.map((value, i) => (
        <TableCell key={i} className="text-end font-mono text-xs">
          {value}
        </TableCell>
      ))}
    </TableRow>
  );
}
