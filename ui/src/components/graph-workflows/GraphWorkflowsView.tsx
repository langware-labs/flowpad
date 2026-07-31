/**
 * Graph Workflows v2 — the per-flow canvas editor/observatory (dock tab per
 * flow, whiteboard pattern). The dock pointer carries the entity
 * (`graph_workflow-<id>`); the view resolves it, builds the folder FSRef from
 * `asset_ref`, and reads/writes graph.json (semantic) + display.json (layout)
 * with debounced persistence. Liveness is push-driven off the unified event
 * bus (`graph_workflow.run.event` / `graph_workflow.node.status`) — see
 * docs/flow-events.md phase 8 Tier B, which retired the private WS dialect.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { GraphWorkflow, FSRef, TypeId, ViewType } from '@sdk';
import {
  graphWorkflows,
  type GraphWorkflowDoc,
  type NodeStatusPayload,
  type RunEventPayload,
} from '@sdk/services/graph-workflows';
import { useConnectionStatus, useEntity, useOnTag } from '@sdk/react/hooks';
import { useAgentContext } from '@src/contexts/agent-context';
import { reindexAfterWrite } from '@src/hooks/use-fs-ref-content';
import { DockPointer, useDockNavigation } from '@src/navigation';
import { GraphWorkflowCanvas } from './canvas/GraphWorkflowCanvas';
import { InjectPanel } from './panels/InjectPanel';
import { NodeInspector } from './panels/NodeInspector';
import { PaletteTab } from './panels/PaletteTab';
import { RunsPanel } from './panels/RunsPanel';
import { handleNodeStatusForProcWatch } from './proc-watch';
import { useStudio, type DisplayDoc } from './store';
import './graph-workflows.css';

const PANEL_TABS = ['palette', 'inject', 'runs'] as const;
const PERSIST_DEBOUNCE_MS = 750;

/** Debounced last-write-wins persister for one folder file (whiteboard pattern). */
function useFilePersister(ref: FSRef | null, onWritten?: (ref: FSRef) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWritten = useRef<string | null>(null);
  const pending = useRef<string | null>(null);
  useEffect(() => {
    lastWritten.current = null;
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [ref]);
  return useCallback(
    (serialized: string) => {
      if (!ref || serialized === lastWritten.current) return;
      pending.current = serialized;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const payload = pending.current;
        if (payload == null || payload === lastWritten.current) return;
        lastWritten.current = payload;
        void ref
          .write(payload)
          .then(() => onWritten?.(ref))
          .catch((e) => console.error('flow persist failed', e));
      }, PERSIST_DEBOUNCE_MS);
    },
    [ref, onWritten],
  );
}

export function GraphWorkflowsView() {
  const { navigation, currentDock } = useDockNavigation();
  const pointer = currentDock?.pointer;
  const typeId = useMemo(() => {
    if (!pointer?.startsWith(GraphWorkflow.type + TypeId.DELIMITER)) return null;
    try {
      return new TypeId(pointer);
    } catch {
      return null;
    }
  }, [pointer]);

  const { data: flow, isLoading } = useEntity<GraphWorkflow>(typeId);
  const { computeNode } = useAgentContext();

  const assetRef = flow?.asset_ref ?? null;
  const computeNodeKey = computeNode?.typeId?.toString() ?? null;
  const fsRef = useMemo(() => {
    if (!assetRef || !computeNode?.typeId) return null;
    return new FSRef(assetRef.replace(/^\//, ''), computeNode.typeId, 'folder');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetRef, computeNodeKey]);
  const graphRef = useMemo(() => fsRef?.child('graph.json') ?? null, [fsRef]);
  const displayRef = useMemo(() => fsRef?.child('display.json') ?? null, [fsRef]);

  // Reindex after graph.json writes so the GraphWorkflow row (name/enabled/node
  // counts) tracks canvas edits; display.json is excluded from the asset hash,
  // so its writes never reindex.
  const reindexGraph = useCallback((r: FSRef) => reindexAfterWrite(`/${r.path}`), []);
  const persistGraph = useFilePersister(graphRef, reindexGraph);
  const persistDisplay = useFilePersister(displayRef);

  const doc = useStudio((s) => s.doc);
  const flowId = useStudio((s) => s.flowId);
  const flowName = useStudio((s) => s.flowName);
  const flowEnabled = useStudio((s) => s.flowEnabled);
  const connected = useStudio((s) => s.connected);
  const bootError = useStudio((s) => s.bootError);
  const panelTab = useStudio((s) => s.panelTab);
  const setPanelTab = useStudio((s) => s.setPanelTab);
  const selectedNodeId = useStudio((s) => s.selectedNodeId);
  const selectNode = useStudio((s) => s.selectNode);
  const { isConnected } = useConnectionStatus();
  const selectedNode = doc?.nodes.find((n) => n.id === selectedNodeId) ?? null;

  // Load the flow's documents whenever the pointer/entity resolves.
  useEffect(() => {
    const st = useStudio.getState();
    st.reset(typeId?.id ?? null);
    if (!typeId || !flow || !graphRef || !displayRef) return;
    let cancelled = false;
    void (async () => {
      try {
        const [graphRaw, displayRaw] = await Promise.all([
          graphRef.read(),
          displayRef.read().catch(() => '{}'),
        ]);
        if (cancelled) return;
        const parsedDoc = JSON.parse(graphRaw || '{}') as GraphWorkflowDoc;
        parsedDoc.nodes ??= [];
        parsedDoc.edges ??= [];
        let display: DisplayDoc = { version: 1, nodes: {} };
        try {
          const d = JSON.parse(displayRaw || '{}') as Partial<DisplayDoc>;
          display = { version: 1, nodes: d.nodes ?? {} };
        } catch {
          // layout is best-effort — a corrupt display.json falls back to auto-grid
        }
        useStudio.getState().setFlow({
          flowId: typeId.id,
          name: flow.name || parsedDoc.name || '(unnamed flow)',
          enabled: (flow.enabled ?? true) && (parsedDoc.enabled ?? true),
          doc: parsedDoc,
          display,
        });
        const runs = await graphWorkflows.listRuns(typeId.id).catch(() => undefined);
        if (!cancelled && runs) useStudio.getState().setRuns(runs);
      } catch (e) {
        if (!cancelled) useStudio.getState().setBootError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeId?.toString(), flow?.id, graphRef, displayRef]);

  // Wire the store's persistence + navigation callbacks.
  useEffect(() => {
    useStudio.getState().setWriters({
      persistDoc: (d) => persistGraph(JSON.stringify(d, null, 2) + '\n'),
      persistDisplay: (d) => persistDisplay(JSON.stringify(d, null, 2) + '\n'),
      openProcess: (processId) =>
        navigation.openDock(new DockPointer(ViewType.SHELL, `agentic_process-${processId}`)),
    });
  }, [persistGraph, persistDisplay, navigation]);

  // Live streams off the unified bus. The bus already routes by target, and the
  // backend stamps `target = graph_workflow:<id>` — so filter there rather than
  // re-deriving `flow_id` on the client and re-checking it in the store.
  const flowTarget = flowId ? `graph_workflow:${flowId}` : undefined;

  useOnTag(
    'graph_workflow.run.event',
    (e) => {
      const payload = e.data as unknown as RunEventPayload;
      useStudio.getState().applyRunEvent(payload);
      const current = useStudio.getState().flowId;
      if (current && (payload.kind === 'run_start' || payload.kind === 'run_end')) {
        void graphWorkflows.listRuns(current).then((runs) => {
          if (runs && useStudio.getState().flowId === current) useStudio.getState().setRuns(runs);
        });
      }
    },
    { target: flowTarget },
  );

  useOnTag(
    'graph_workflow.node.status',
    (e) => {
      const payload = e.data as unknown as NodeStatusPayload;
      useStudio.getState().applyNodeStatus(payload);
      handleNodeStatusForProcWatch(payload);
    },
    { target: flowTarget },
  );

  // Every forwarded event, so a subscription inlet lights when its pattern
  // matches — the visible answer to "is this flow actually being fed?".
  useOnTag('*', (e) => {
    useStudio.getState().noteBusEvent(e.tag, e.target, e.ctx?.scope);
  });

  // The header dot reflects the actual socket. It used to be set from a
  // one-shot bootstrap promise that could only ever resolve true, so it never
  // went dark on a dropped connection.
  useEffect(() => {
    useStudio.getState().setConnected(isConnected);
  }, [isConnected]);

  const toggleEnabled = useCallback(() => {
    const st = useStudio.getState();
    const next = !st.flowEnabled;
    useStudio.setState({ flowEnabled: next });
    st.mutateDoc((d) => ({ ...d, enabled: next }));
    if (flow) {
      flow.enabled = next;
      void flow.save().catch((e) => console.error('flow enable toggle failed', e));
    }
  }, [flow]);

  if (!typeId) {
    return (
      <div className="graph-workflows">
        <div className="afl-empty">
          <div className="eye">graph workflows</div>
          <h2>No flow selected</h2>
          <p>Pick a flow from the left menu, or create one with “+ New flow”.</p>
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="graph-workflows">
        <div style={{ padding: 40, fontFamily: 'var(--mono)', fontSize: 12 }}>
          <b>Flow failed to load</b>
          <pre>{bootError}</pre>
        </div>
      </div>
    );
  }

  if (isLoading || !doc) {
    return (
      <div className="graph-workflows">
        <div className="afl-empty">
          <div className="eye">graph workflows</div>
          <h2>Loading…</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-workflows">
      <GraphWorkflowCanvas />

      <div className="topbar">
        <div className="brand">
          <div className="mark" />
          <div>
            <b>{flowName}</b>
            <span>
              {doc.nodes.length} nodes · {doc.edges.length} edges
            </span>
          </div>
        </div>
        <div className="spacer" />
        <button
          className={`chip ${flowEnabled ? 'on' : ''}`}
          title={flowEnabled ? 'Flow is active — click to deactivate' : 'Flow is inactive — click to activate'}
          onClick={toggleEnabled}
        >
          <span className={`dot ${flowEnabled ? 'ok' : ''}`} />
          {flowEnabled ? 'active' : 'inactive'}
        </button>
        <div className="chip" style={{ cursor: 'default' }} title="live stream connection">
          <span className={`dot ${connected ? 'ok' : ''}`} />
          live
        </div>
        {PANEL_TABS.map((t) => (
          <button key={t} className={`chip ${panelTab === t ? 'on' : ''}`} onClick={() => setPanelTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="side">
        {panelTab === 'palette' && <PaletteTab />}
        {panelTab === 'inject' && <InjectPanel />}
        {panelTab === 'runs' && <RunsPanel />}
      </div>

      <div className="hint">drag from the palette to add · connect handles to route events · ⌫ deletes</div>

      <div className={`drawer-scrim ${selectedNode ? 'open' : ''}`} onClick={() => selectNode(null)} />
      <div className={`drawer ${selectedNode ? 'open' : ''}`}>
        {selectedNode && (
          <>
            <div className="drawer-head">
              <div>
                <div className="eye">{selectedNode.node_type.replace('_', ' ')}</div>
                <h2>{selectedNode.name || '(unnamed)'}</h2>
              </div>
              <button className="drawer-x" onClick={() => selectNode(null)}>
                ✕
              </button>
            </div>
            <div className="drawer-body">
              <NodeInspector node={selectedNode} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
