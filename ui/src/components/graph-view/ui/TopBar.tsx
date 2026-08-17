import { RefreshCw, Target, X } from 'lucide-react';
import type Graph from 'graphology';
import { Trans, useLingui } from '@lingui/react/macro';
import { SearchInput, type SearchResultRow } from './SearchInput';
import { FilterChips } from './FilterChips';
import { WORLDVIEW_COLOR_MODES, type WorldViewColorMode } from '@src/types/WorldViewColorMode';

type LocalModeState = {
  rootKey: string;
  rootLabel: string;
  rootType: string;
  depth: number;
  visibleCount: number;
};

type Props = {
  title: string;
  actionLabel: string;
  actionPendingLabel: string;
  graph: Graph | null;
  nodeCount: number;
  visibleNodeCount: number;
  edgeCount: number;
  hidden: ReadonlySet<string>;
  building: boolean;
  actionDisabled?: boolean;
  depthOptions?: number[];
  colorMode?: WorldViewColorMode;
  localMode: LocalModeState | null;
  onToggleType: (type: string) => void;
  onSelectAllTypes: () => void;
  onClearAllTypes: () => void;
  onSearch: (q: string) => SearchResultRow[];
  searchQuery?: string;
  onSelectResult: (key: string) => void;
  onRebuild: () => void;
  onChangeDepth: (depth: number) => void;
  onChangeColorMode?: (mode: WorldViewColorMode) => void;
  onExitLocal: () => void;
};

export function TopBar({
  title,
  actionLabel,
  actionPendingLabel,
  graph,
  nodeCount,
  visibleNodeCount,
  edgeCount,
  hidden,
  building,
  actionDisabled = false,
  depthOptions = [1, 2, 3],
  colorMode,
  localMode,
  onToggleType,
  onSelectAllTypes,
  onClearAllTypes,
  onSearch,
  searchQuery = '',
  onSelectResult,
  onRebuild,
  onChangeDepth,
  onChangeColorMode,
  onExitLocal,
}: Props) {
  const { t } = useLingui();
  const colorModeLabels: Record<WorldViewColorMode, string> = {
    type: t`Type`,
    footprint: t`Footprint`,
    cost: t`Cost`,
    activity: t`Activity`,
  };

  return (
    <div className="top-bar">
      <div className="top-bar-row">
        <div className="title">
          <span className="title-dot" />
          <span>{title}</span>
        </div>
        <SearchInput query={searchQuery} onQueryChange={onSearch} onSelect={onSelectResult} />
        {colorMode && onChangeColorMode && (
          <div className="color-mode-control" role="group" aria-label={t`Color by`}>
            {WORLDVIEW_COLOR_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={`color-mode-btn ${mode === colorMode ? 'active' : ''}`}
                aria-pressed={mode === colorMode}
                onClick={() => onChangeColorMode(mode)}
              >
                {colorModeLabels[mode]}
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        <div className="counts">
          <span>
            <strong>{visibleNodeCount}</strong> / {nodeCount} <Trans>nodes</Trans>
          </span>
          <span>
            <strong>{edgeCount}</strong> <Trans>edges</Trans>
          </span>
        </div>
        <button className="btn" onClick={onRebuild} disabled={building || actionDisabled}>
          <RefreshCw size={12} className={building ? 'spin' : ''} />
          {building ? actionPendingLabel : actionLabel}
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
          <span className="local-label">
            <Trans>Local graph:</Trans>
          </span>
          <span className="local-root">{localMode.rootLabel}</span>
          <span className="local-meta">({localMode.rootType})</span>
          <span className="local-sep" />
          <span className="local-meta">
            <Trans>depth</Trans>
          </span>
          {depthOptions.map((d) => (
            <button
              key={d}
              type="button"
              className={`depth-btn ${d === localMode.depth ? 'active' : ''}`}
              onClick={() => onChangeDepth(d)}
              title={
                d === 0
                  ? `Show complete hierarchy from ${localMode.rootLabel}`
                  : `Show ${d} hop${d > 1 ? 's' : ''} from ${localMode.rootLabel}`
              }
            >
              {d === 0 ? t`All` : d}
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
