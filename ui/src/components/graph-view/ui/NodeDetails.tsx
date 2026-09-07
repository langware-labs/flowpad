import { MousePointer2, Target } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Agent, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { AgentDeploymentsSection } from '@src/components/assets/editor/agent-profile/AgentDeploymentsSection';
import { EntityIcon } from './EntityIcon';
import { hexForType } from './typeColors';
import type { NodeData } from '../graph/graphEngine';
import { paletteForTheme, type EdgeKind } from '../graph/themeColors';

const EDGE_KIND_COLOR = paletteForTheme('dark').edgeKindColor;

type Props = {
  node: NodeData | null;
  localRootKey: string | null;
  showWorldViewProperties?: boolean;
  onNeighborClick: (key: string) => void;
  onFocus: (key: string) => void;
};

function formatProperty(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

function propertyLabel(key: string): string {
  return key.replaceAll('_', ' ');
}

function AgentDeploymentControls({ id }: { id: string }) {
  const { data: agent } = useEntity<Agent>(new TypeId(Agent.type, id));
  if (!agent) return null;

  return (
    <div className="section" data-testid="worldview-agent-deployments">
      <h3><Trans>Deployments</Trans></h3>
      <AgentDeploymentsSection agent={agent} />
    </div>
  );
}

export function PropertyPanel({
  node,
  localRootKey,
  showWorldViewProperties = false,
  onNeighborClick,
  onFocus,
}: Props) {
  const { t } = useLingui();

  if (!node) {
    return (
      <aside className="property-panel">
        <div className="property-empty">
          <div className="ring">
            <MousePointer2 size={26} />
          </div>
          <p className="hint">
            <Trans>Click a node to view its properties,<br />edges, and neighbors.</Trans>
          </p>
        </div>
      </aside>
    );
  }

  const pillColor = hexForType(node.type);

  return (
    <aside className="property-panel">
      <div className="property-body">
        <div className="property-header">
          <div className="icon-and-pill">
            <div className="big-icon" style={{ background: `${pillColor}33`, color: pillColor }}>
              <EntityIcon type={node.type} size={20} />
            </div>
            <span className="type-pill" style={{ color: pillColor }}>{node.type}</span>
            {node.isGhost && <span className="ghost-badge" title={t`referenced but not in entities table`}><Trans>ghost</Trans></span>}
          </div>
          <h2 title={node.label}>{node.label}</h2>
          <button
            type="button"
            className="focus-btn"
            onClick={() => onFocus(node.key)}
            disabled={localRootKey === node.key}
            title={localRootKey === node.key ? t`Already focused` : t`Focus local graph here`}
          >
            <Target size={12} />
            {localRootKey === node.key ? <Trans>Focused</Trans> : <Trans>Focus local graph</Trans>}
          </button>
        </div>

        <div className="section">
          <h3><Trans>Identity</Trans></h3>
          <div className="kv-row"><span className="k">type</span><span className="v">{node.type}</span></div>
          <div className="kv-row"><span className="k">id</span><span className="v">{node.id}</span></div>
          <div className="kv-row"><span className="k">community</span><span className="v">{node.community}</span></div>
          <div className="kv-row"><span className="k">degree</span><span className="v">{node.degree}</span></div>
        </div>

        {showWorldViewProperties && Object.keys(node.properties).length > 0 && (
          <div className="section" data-testid="worldview-properties">
            <h3><Trans>Deployment details</Trans></h3>
            {Object.entries(node.properties).map(([key, value]) => (
              <div className="worldview-property" key={key} data-property={key}>
                <span className="k">{propertyLabel(key)}</span>
                <pre className="v">{formatProperty(value)}</pre>
              </div>
            ))}
          </div>
        )}

        {node.type === Agent.type && <AgentDeploymentControls id={node.id} />}

        <div className="section">
          <h3><Trans>Edges by kind</Trans></h3>
          {Object.keys(node.edgeCounts).length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}><Trans>no edges</Trans></p>
          )}
          {Object.entries(node.edgeCounts).map(([kind, n]) => (
            <div key={kind} className="edge-kind-row">
              <span
                className="dot"
                style={{ background: EDGE_KIND_COLOR[kind as EdgeKind] ?? '#94a3b8' }}
              />
              <span className="name">{kind}</span>
              <span className="num">{n}</span>
            </div>
          ))}
        </div>

        {node.neighbors.length > 0 && (
          <div className="section">
            <h3><Trans>Neighbors (<span>{node.neighbors.length}</span>)</Trans></h3>
            {node.neighbors.slice(0, 20).map((n) => (
              <div
                key={n.key + n.edgeKind}
                className="neighbor-row"
                onClick={() => onNeighborClick(n.key)}
                title={`${n.type} · ${n.edgeKind}`}
              >
                <span className="icon"><EntityIcon type={n.type} size={13} /></span>
                <span className="label">{n.label}</span>
                <span className="kind">{n.edgeKind}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
