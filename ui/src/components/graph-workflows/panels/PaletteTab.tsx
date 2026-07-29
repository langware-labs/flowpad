/**
 * Node palette — the n8n-style drag-drop source for creating nodes. Currently
 * hosted as a right-side panel tab, but deliberately modular (pure component +
 * exported drag MIME/recipe) so it can relocate (left rail, floating dock)
 * without touching the canvas contract: the canvas only listens for
 * `PALETTE_DRAG_MIME` drops (click-to-place is handled here).
 */
import type { GraphWorkflowDocNode } from '@sdk/services/graph-workflows';
import { newNodeId, useStudio } from '../store';

export const PALETTE_DRAG_MIME = 'application/x-flowpad-node';

type NodeType = GraphWorkflowDocNode['node_type'];

const ITEMS: { type: NodeType; label: string; glyph: string; blurb: string }[] = [
  { type: 'trigger', label: 'Trigger', glyph: '◈', blurb: 'Fires the flow — links a Trigger entity, emits `fired`.' },
  { type: 'agent', label: 'Agent', glyph: '▣', blurb: 'Spawned worker (skill / instruction). Auto-emits `done` with its output + artifacts.' },
  { type: 'function', label: 'Function', glyph: '⌁', blurb: 'A GraphWorkflowFunction — on_graph_workflow_event(name, data, flow_ctx); inline or subprocess.' },
];

export function paletteLabel(type: NodeType): string {
  return ITEMS.find((i) => i.type === type)?.label ?? type;
}

export function defaultNodeData(type: NodeType): Record<string, unknown> {
  if (type === 'trigger') return { typeid: '' };
  if (type === 'function') return { function: '', runtime: 'inline' };
  return { program_kind: 'instruction', program_ref: '', prompt: '', model_size: 'sm' };
}

/** Click-to-place: append the node at a free auto-grid spot. */
function paletteClickPlace(type: NodeType) {
  const st = useStudio.getState();
  if (!st.doc) return;
  const id = newNodeId();
  const i = st.doc.nodes.length;
  st.moveNode(id, 80 + (i % 3) * 300, 80 + Math.floor(i / 3) * 170);
  st.mutateDoc((d) => {
    d.nodes.push({ id, node_type: type, name: paletteLabel(type), node_data: defaultNodeData(type) });
    return d;
  });
  st.selectNode(id);
}

export function PaletteTab() {
  return (
    <div className="afl-panel afl-palette">
      <div className="eye">palette</div>
      <p className="afl-note">Drag onto the canvas, or click to place.</p>
      {ITEMS.map((item) => (
        <div
          key={item.type}
          className={`afl-pal-item ${item.type}`}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(PALETTE_DRAG_MIME, item.type);
            e.dataTransfer.effectAllowed = 'copy';
          }}
          onClick={() => paletteClickPlace(item.type)}
        >
          <span className="glyph">{item.glyph}</span>
          <div>
            <b>{item.label}</b>
            <span>{item.blurb}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
