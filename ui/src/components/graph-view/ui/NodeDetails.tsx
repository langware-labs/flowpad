/**
 * The Details tab: what the graph knows about the selected node.
 *
 * Body only — the node's icon, name and focus control live in `NodePanel`'s
 * header, shared with every other tab, so they are not repeated here.
 */
import { Trans } from '@lingui/react/macro';
import { Agent, Deployment, isTypeId, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { AgentPlacesColumn } from '@src/components/assets/editor/agent-profile/AgentPlacesColumn';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { EntityIcon } from './EntityIcon';
import type { NodeData } from '../graph/graphModel';
import { paletteForTheme, type EdgeKind } from '../graph/themeColors';

const EDGE_KIND_COLOR = paletteForTheme('dark').edgeKindColor;

type Props = {
  node: NodeData;
  showWorldViewProperties?: boolean;
  onNeighborClick: (key: string) => void;
};

function formatProperty(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

function propertyLabel(key: string): string {
  return key.replaceAll('_', ' ');
}

/** An agent node: the deployments it is the main agent of, each a link to its project's deployment page. */
function AgentDeploymentLinks({ id }: { id: string }) {
  const { data: agent } = useEntity<Agent>(new TypeId(Agent.type, id));
  if (!agent) return null;
  return (
    <div className="section" data-testid="worldview-agent-deployments">
      <AgentPlacesColumn agent={agent} />
    </div>
  );
}

/** A deployment node of a project: a link to its page in the project's Deployments, where it is run. */
function ProjectDeploymentLink({ id }: { id: string }) {
  const { navigation } = useDockNavigation();
  const { data: deployment } = useEntity<Deployment>(new TypeId(Deployment.type, id));
  const pointer = deployment?.projectPagePointer;
  if (!pointer) return null;
  return (
    <div className="section" data-testid="worldview-project-deployment">
      <Button size="sm" variant="outline" onClick={() => navigation.openDock(pointer)} data-testid="worldview-open-deployment">
        <Trans>Open deployment</Trans>
      </Button>
    </div>
  );
}

/** Whether a node is a deployment of a project — its parent, as `Deployment.projectTypeId` reads it. */
function isProjectDeployment(node: NodeData): boolean {
  if (node.type !== Deployment.type) return false;
  const parent = node.properties?.parent_type_id;
  return typeof parent === 'string' && isTypeId(parent) && new TypeId(parent).type === 'project';
}

export function NodeDetails({ node, showWorldViewProperties = false, onNeighborClick }: Props) {
  return (
    <>
      {isProjectDeployment(node) && <ProjectDeploymentLink id={node.id} />}
      <div className="section">
        <h3>
          <Trans>Identity</Trans>
        </h3>
        <div className="kv-row">
          <span className="k">
            <Trans>type</Trans>
          </span>
          <span className="v">{node.type}</span>
        </div>
        <div className="kv-row">
          <span className="k">id</span>
          <span className="v">{node.id}</span>
        </div>
        <div className="kv-row">
          <span className="k">
            <Trans>community</Trans>
          </span>
          <span className="v">{node.community}</span>
        </div>
        <div className="kv-row">
          <span className="k">
            <Trans>degree</Trans>
          </span>
          <span className="v">{node.degree}</span>
        </div>
      </div>

      {showWorldViewProperties && Object.keys(node.properties).length > 0 && (
        <div className="section" data-testid="worldview-properties">
          <h3>
            <Trans>Deployment details</Trans>
          </h3>
          {Object.entries(node.properties).map(([key, value]) => (
            <div className="worldview-property" key={key} data-property={key}>
              <span className="k">{propertyLabel(key)}</span>
              <pre className="v">{formatProperty(value)}</pre>
            </div>
          ))}
        </div>
      )}

      {node.type === Agent.type && <AgentDeploymentLinks id={node.id} />}

      <div className="section">
        <h3>
          <Trans>Edges by kind</Trans>
        </h3>
        {Object.keys(node.edgeCounts).length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            <Trans>no edges</Trans>
          </p>
        )}
        {Object.entries(node.edgeCounts).map(([kind, n]) => (
          <div key={kind} className="edge-kind-row">
            <span className="dot" style={{ background: EDGE_KIND_COLOR[kind as EdgeKind] ?? '#94a3b8' }} />
            <span className="name">{kind}</span>
            <span className="num">{n}</span>
          </div>
        ))}
      </div>

      {node.neighbors.length > 0 && (
        <div className="section">
          <h3>
            <Trans>
              Neighbors (<span>{node.neighbors.length}</span>)
            </Trans>
          </h3>
          {node.neighbors.slice(0, 20).map((n) => (
            <div
              key={n.key + n.edgeKind}
              className="neighbor-row"
              onClick={() => onNeighborClick(n.key)}
              title={`${n.type} · ${n.edgeKind}`}
            >
              <span className="icon">
                <EntityIcon type={n.type} size={13} />
              </span>
              <span className="label">{n.label}</span>
              <span className="kind">{n.edgeKind}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
