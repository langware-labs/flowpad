/**
 * The resolved chain as an indented tree: entry at the top, each source under
 * it in fallback order, down to the roots. Rows are coloured by health, the
 * preferred path is emphasised, and the router's sticky root for the caller
 * is flagged. Rows navigate to the hop's own detail.
 */
import type { LLMChain } from '@sdk';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle, CircleSlash, KeyRound, Pin, Zap, type LucideIcon } from 'lucide-react';
import { useMemo } from 'react';

import { Badge } from '@src/components/ui/badge';

import { buildChainTree, type ChainTreeNode, type HopHealth } from './chain-tree';
import { TONE } from './tone';

const HEALTH_TONE: Record<HopHealth, string> = {
  ok: 'text-foreground',
  disabled: 'text-muted-foreground line-through',
  no_credential: 'text-amber-500',
  breaker_open: 'text-destructive',
  missing: 'text-destructive',
};

/** One row per health, in the same shape as `HEALTH_TONE` above; `ok` earns no badge. */
const HEALTH_BADGE: Record<HopHealth, { icon: LucideIcon; tone: string; label: MessageDescriptor } | null> = {
  ok: null,
  disabled: { icon: CircleSlash, tone: 'text-muted-foreground', label: msg`disabled` },
  no_credential: { icon: KeyRound, tone: TONE.amber, label: msg`no key` },
  breaker_open: { icon: Zap, tone: TONE.destructive, label: msg`breaker open` },
  missing: { icon: AlertTriangle, tone: TONE.destructive, label: msg`not visible` },
};

function HealthBadge({ node }: { node: ChainTreeNode }) {
  const { t } = useLingui();
  const badge = HEALTH_BADGE[node.health];
  if (!badge) return null;
  const Icon = badge.icon;
  return (
    <Badge variant="outline" className={`gap-1 ${badge.tone}`}>
      <Icon className="h-3 w-3" />
      {t(badge.label)}
    </Badge>
  );
}

export interface ChainTreeProps {
  chain: LLMChain | null | undefined;
  onOpen?: (id: string) => void;
}

export function ChainTree({ chain, onOpen }: ChainTreeProps) {
  const { t } = useLingui();
  const nodes = useMemo(() => buildChainTree(chain), [chain]);
  if (!chain) return null;
  return (
    <ol className="space-y-0.5 text-sm" data-testid="chain-tree">
      {nodes.map((n) => (
        <li
          key={n.key}
          data-testid={`chain-node-${n.id}`}
          data-depth={n.depth}
          style={{ paddingInlineStart: `${n.depth * 1.25}rem` }}
          className={`flex items-center gap-2 rounded px-1 py-0.5 ${n.isOnPath ? 'bg-primary/5' : ''}`}
        >
          <span className="text-muted-foreground">{n.depth === 0 ? '●' : n.isRoot ? '└' : '├'}</span>
          <button
            type="button"
            className={`truncate text-start hover:underline ${HEALTH_TONE[n.health]}`}
            disabled={!onOpen || n.health === 'missing'}
            onClick={() => onOpen?.(n.id)}
          >
            {n.name}
          </button>
          {n.hop?.provider && <span className="font-mono text-[11px] text-muted-foreground">{n.hop.provider}</span>}
          {n.depth > 0 && n.pathIndexes.length > 0 && (
            <span className="text-[11px] text-muted-foreground" title={t`Fallback order under its parent`}>
              #{n.order + 1}
            </span>
          )}
          {n.isSticky && (
            <Badge variant="outline" className={`gap-1 ${TONE.sky}`}>
              <Pin className="h-3 w-3" />
              <Trans>sticky for you</Trans>
            </Badge>
          )}
          <HealthBadge node={n} />
        </li>
      ))}
    </ol>
  );
}
