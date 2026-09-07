/**
 * The one panel beside the graph.
 *
 * There were briefly two — a property inspector on the right and an access
 * editor on the left — so selecting a node opened a window on each side of the
 * canvas, both repeating its name. They are one panel now, anchored left, and
 * the node's identity is the HEADER rather than something each tab restates:
 * it belongs to the selection, not to either view of it. Only the body switches.
 */
import { MousePointer2, Target, X } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { AccessTab } from './AccessTab';
import { EntityIcon } from './EntityIcon';
import { NodeDetails } from './NodeDetails';
import { hexForType } from './typeColors';
import type { NodeData } from '../graph/graphModel';

type Tab = 'details' | 'access';

type Props = {
  node: NodeData | null;
  localRootKey: string | null;
  showWorldViewProperties?: boolean;
  /** Access is a world-view concept; other surfaces get Details alone, and no tabs. */
  showAccess?: boolean;
  onNeighborClick: (key: string) => void;
  onFocus: (key: string) => void;
  onClose: () => void;
  /** Refresh the graph so an edge badge matches what the Access tab just saved. */
  onChanged: () => void;
};

export function NodePanel({
  node,
  localRootKey,
  showWorldViewProperties = false,
  showAccess = false,
  onNeighborClick,
  onFocus,
  onClose,
  onChanged,
}: Props) {
  const { t } = useLingui();
  // Deliberately NOT reset when the selection changes: reviewing access means
  // clicking node after node, and being thrown back to Details every time would
  // make that unusable.
  const [tab, setTab] = useState<Tab>('details');

  if (!node) {
    return (
      <aside className="node-panel" data-testid="node-panel">
        <div className="property-empty">
          <div className="ring">
            <MousePointer2 size={26} />
          </div>
          <p className="hint">
            <Trans>
              Click a node to view its properties,
              <br />
              edges, and neighbors.
            </Trans>
          </p>
        </div>
      </aside>
    );
  }

  const active: Tab = showAccess ? tab : 'details';
  const pillColor = hexForType(node.type);

  return (
    <aside className="node-panel" data-testid="node-panel">
      <header className={`node-panel-header${showAccess ? '' : 'node-panel-header--divided'}`}>
        <div className="icon-and-pill">
          <div className="big-icon" style={{ background: `${pillColor}33`, color: pillColor }}>
            <EntityIcon type={node.type} size={20} />
          </div>
          <span className="type-pill" style={{ color: pillColor }}>
            {node.type}
          </span>
          {node.isGhost && (
            <span className="ghost-badge" title={t`referenced but not in entities table`}>
              <Trans>ghost</Trans>
            </span>
          )}
          <button type="button" className="node-panel-close" onClick={onClose} aria-label={t`Close panel`}>
            <X size={15} />
          </button>
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
      </header>

      {showAccess && (
        <div className="node-panel-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={active === 'details'}
            data-testid="tab-details"
            onClick={() => setTab('details')}
          >
            <Trans>Details</Trans>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={active === 'access'}
            data-testid="tab-access"
            onClick={() => setTab('access')}
          >
            <Trans>Access</Trans>
          </button>
        </div>
      )}

      <div className="node-panel-body">
        {active === 'access' ? (
          <AccessTab node={node} onChanged={onChanged} />
        ) : (
          <NodeDetails
            node={node}
            showWorldViewProperties={showWorldViewProperties}
            onNeighborClick={onNeighborClick}
          />
        )}
      </div>
    </aside>
  );
}
