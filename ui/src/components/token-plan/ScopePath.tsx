/**
 * "You spend through A → B → C" — one chip per hop of the active scope's
 * path (nearest first). Hover shows that hop's own budget windows; click opens
 * the hop's expert page. The first hop is the scope itself, so it is shown as a
 * plain lead-in rather than as a chip when it is the caller's own default.
 */
import type { TokenPlanHop, TokenPlanRemaining } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight } from 'lucide-react';

import { openLlmEndpoint } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { formatAmount } from '@src/components/llm-endpoints/usage-math';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

import { windowLabel } from './token-plan-math';

export interface ScopePathProps {
  path: readonly TokenPlanHop[];
  /** Per-hop windows, when known (the scope's own endpoint is; others are hinted). */
  remainingByHop?: Record<string, readonly TokenPlanRemaining[]>;
}

export function ScopePath({ path, remainingByHop = {} }: ScopePathProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  if (path.length === 0) return null;
  const hint = (hop: TokenPlanHop): string => {
    const rows = remainingByHop[hop.endpoint_id] ?? [];
    if (rows.length === 0) return hop.name;
    return rows.map((r) => `${formatAmount(r.key, r.remaining)} ${t(windowLabel(r.window))}`).join(' · ');
  };
  return (
    <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground" data-testid="scope-path">
      <span className="me-1">
        <Trans>You spend through</Trans>
      </span>
      {path.map((hop, i) => (
        <span key={hop.endpoint_id} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-3 w-3 opacity-60" />}
          <button
            type="button"
            title={hint(hop)}
            data-testid={`path-chip-${hop.endpoint_id}`}
            onClick={() => openLlmEndpoint(navigation, hop.endpoint_id)}
            className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-foreground hover:bg-accent"
          >
            {hop.name}
          </button>
        </span>
      ))}
    </p>
  );
}
