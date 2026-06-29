import { RefreshCw, Target, X } from 'lucide-react';
import type Graph from 'graphology';
import { Trans, useLingui } from '@lingui/react/macro';
import { SearchInput, type SearchResultRow } from './SearchInput';
import { FilterChips } from './FilterChips';

type LocalModeState = {
  rootKey: string;
  rootLabel: string;
  rootType: string;
  depth: number;
  visibleCount: number;
};

type Props = {
  graph: Graph | null;
  nodeCount: number;
  visibleNodeCount: number;
  edgeCount: number;
  hidden: Set<string>;
  building: boolean;
  localMode: LocalModeState | null;
  onToggleType: (type: string) => void;
  onSelectAllTypes: () => void;
  onClearAllTypes: () => void;
  onSearch: (q: string) => SearchResultRow[];
  onSelectResult: (key: string) => void;
  onRebuild: () => void;
  onChangeDepth: (depth: number) => void;
  onExitLocal: () => void;
};

export function TopBar({
  graph,
  nodeCount,
  visibleNodeCount,
  edgeCount,
  hidden,
  building,
  localMode,
  onToggleType,
  onSelectAllTypes,
  onClearAllTypes,
  onSearch,
  onSelectResult,
  onRebuild,
  onChangeDepth,
  onExitLocal,
}: Props) {
  const { t } = useLingui();

  return (
    <div className="top-bar">
      <div className="top-bar-row">
        <div className="title">
          <span className="title-dot" />
          <span><Trans>Context Graph</Trans></span>
        </div>
        <SearchInput onQueryChange={onSearch} onSelect={onSelectResult} />
        <div className="spacer" />
        <div className="counts">
          <span><strong>{visibleNodeCount}</strong> / {nodeCount} <Trans>nodes</Trans></span>
          <span><strong>{edgeCount}</strong> <Trans>edges</Trans></span>
        </div>
        <button className="btn" onClick={onRebuild} disabled={building}>
          <RefreshCw size={12} className={building ? 'spin' : ''} />
          {building ? t`Building…` : t`Rebuild`}
        </button>
      </div>
      <FilterChips
        graph={graph}
        hidden={hidden}
        onToggle={onToggleType}
        onSelectAll={onSelectAllTypes}
        onClearAll={onClearAllTypes}
      />
      {localMode && (
        <div className="local-banner">
          <Target size={12} />
          <span className="local-label"><Trans>Local graph:</Trans></span>
          <span className="local-root">{localMode.rootLabel}</span>
          <span className="local-meta">({localMode.rootType})</span>
          <span className="local-sep" />
          <span className="local-meta"><Trans>depth</Trans></span>
          {[1, 2, 3].map((d) => (
            <button
              key={d}
              type="button"
              className={`depth-btn ${d === localMode.depth ? 'active' : ''}`}
              onClick={() => onChangeDepth(d)}
              title={`Show ${d} hop${d > 1 ? 's' : ''} from ${localMode.rootLabel}`}
            >
              {d}
            </button>
          ))}
          <span className="local-sep" />
          <span className="local-meta">
            {localMode.visibleCount} {localMode.visibleCount === 1 ? t`node` : t`nodes`} <Trans>visible</Trans>
          </span>
          <div className="local-spacer" />
          <button type="button" className="chip-action" onClick={onExitLocal} title={t`Back to full graph`}>
            <X size={11} />
            <Trans>Exit local</Trans>
          </button>
        </div>
      )}
    </div>
  );
}
