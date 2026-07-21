import { useMemo } from 'react';
import type Graph from 'graphology';
import { EyeOff, Eye } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react/macro';
import { EntityIcon } from './EntityIcon';
import { hexForType } from './typeColors';

type Props = {
  graph: Graph | null;
  hidden: ReadonlySet<string>;
  onToggle: (type: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
};

export function FilterChips({ graph, hidden, onToggle, onSelectAll, onClearAll }: Props) {
  const { t } = useLingui();
  const types = useMemo(() => {
    if (!graph) return [] as Array<{ type: string; count: number }>;
    const counts = new Map<string, number>();
    graph.forEachNode((_, attrs) => {
      const t = (attrs.entityType as string) ?? 'unknown';
      counts.set(t, (counts.get(t) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }, [graph]);

  if (types.length === 0) return null;

  const activeCount = types.length - hidden.size;
  const allOn = hidden.size === 0;
  const allOff = activeCount === 0;

  return (
    <div className="filters-row" role="group" aria-label={t`Filter by entity type`}>
      <div className="filter-actions">
        <button
          type="button"
          className="chip-action"
          onClick={onSelectAll}
          disabled={allOn}
          title={t`Show all types`}
        >
          <Eye size={11} />
          <Trans>All</Trans>
        </button>
        <button
          type="button"
          className="chip-action"
          onClick={onClearAll}
          disabled={allOff}
          title={t`Hide all types`}
        >
          <EyeOff size={11} />
          <Trans>None</Trans>
        </button>
        <span className="filter-summary">
          {activeCount}/{types.length}
        </span>
      </div>
      <span className="filter-sep" />
      {types.map(({ type, count }) => {
        const active = !hidden.has(type);
        const color = hexForType(type);
        return (
          <button
            key={type}
            type="button"
            className={`chip ${active ? 'active' : ''}`}
            onClick={() => onToggle(type)}
            style={
              active
                ? { borderColor: `${color}66`, background: `${color}22` }
                : undefined
            }
            title={active ? t`Hide ${type}` : t`Show ${type}`}
          >
            <span
              className="chip-dot"
              style={{ background: active ? color : 'transparent', borderColor: color }}
            />
            <EntityIcon type={type} size={12} color={active ? color : undefined} />
            <span className="chip-label">{type}</span>
            <span className="count">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
