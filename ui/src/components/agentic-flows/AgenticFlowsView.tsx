/**
 * Agentic Flows — the flow-graph editor/observatory as a main-UI dock view
 * (dev mode), wearing the hub org-atlas design language. Canvas (React Flow,
 * atlas cards/pills), floating chrome, side panel (emit/journal/chain/wiring),
 * and the atlas reading-drawer as the node inspector.
 *
 * Liveness is push-driven: flowManager 'node_status' + 'topic_event' streams
 * feed the zustand store; the snapshot poll is a 30s reconciliation only.
 */
import { useEffect } from 'react';
import { ViewType } from '@sdk';
import { flowManager } from '@sdk/services/flow-manager';
import { DockPointer, useDockNavigation } from '@src/navigation';
import { FlowCanvas } from './canvas/FlowCanvas';
import { ChainInspector } from './panels/ChainInspector';
import { EmitConsole } from './panels/EmitConsole';
import { JournalTail } from './panels/JournalTail';
import { NodeInspector } from './panels/NodeInspector';
import { WiringEditor } from './panels/WiringEditor';
import { handleNodeStatusForProcWatch } from './proc-watch';
import { useStudio } from './store';
import './agentic-flows.css';

type Tab = 'emit' | 'journal' | 'chain' | 'wiring';
const TABS: Tab[] = ['emit', 'journal', 'chain', 'wiring'];

export function AgenticFlowsView() {
  const connected = useStudio((s) => s.connected);
  const bootError = useStudio((s) => s.bootError);
  const snapshot = useStudio((s) => s.snapshot);
  const journal = useStudio((s) => s.journal);
  const tab = useStudio((s) => s.panelTab);
  const setTab = useStudio((s) => s.setPanelTab);
  const selectedNodeId = useStudio((s) => s.selectedNodeId);
  const selectNode = useStudio((s) => s.selectNode);
  const setSnapshot = useStudio((s) => s.setSnapshot);
  const { navigation } = useDockNavigation();

  const selectedNode = snapshot?.nodes.find((n) => n.id === selectedNodeId);

  // Boot: subscribe to the live streams, seed state, inject in-app process nav.
  useEffect(() => {
    const st = useStudio.getState();
    st.setOpenProcess((processId) =>
      navigation.openDock(new DockPointer(ViewType.SHELL, `agentic_process-${processId}`)),
    );

    let disposed = false;
    const onTopicEvent = (e: Parameters<typeof st.pushEvent>[0]) => {
      useStudio.getState().pushEvent(e);
      useStudio.getState().pulseTopic(e.topic, e.source);
    };
    const onNodeStatus = (msg: Parameters<typeof st.applyNodeStatus>[0]) => {
      useStudio.getState().applyNodeStatus(msg);
      handleNodeStatusForProcWatch(msg);
    };

    void (async () => {
      try {
        await flowManager.bootstrap();
        flowManager.on('topic_event', onTopicEvent);
        flowManager.on('node_status', onNodeStatus);
        const [snap, seed] = await Promise.all([
          flowManager.fetchGraph(),
          flowManager.fetchJournal({ limit: 200 }),
        ]);
        if (disposed) return;
        if (snap) useStudio.getState().setSnapshot(snap);
        if (seed) useStudio.getState().seedJournal(seed);
        useStudio.getState().setConnected(true);
      } catch (e) {
        console.error('AgenticFlows boot failed', e);
        useStudio.getState().setBootError(String(e));
      }
    })();
    return () => {
      disposed = true;
      flowManager.off('topic_event', onTopicEvent);
      flowManager.off('node_status', onNodeStatus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Slow reconciliation sweep — liveness is push-driven.
  useEffect(() => {
    if (!connected) return;
    const id = setInterval(async () => {
      const snap = await flowManager.fetchGraph().catch(() => undefined);
      if (snap) setSnapshot(snap);
    }, 30000);
    return () => clearInterval(id);
  }, [connected, setSnapshot]);

  if (bootError) {
    return (
      <div className="agentic-flows">
        <div style={{ padding: 40, fontFamily: 'var(--mono)', fontSize: 12 }}>
          <b>Agentic Flows failed to load</b>
          <pre>{bootError}</pre>
        </div>
      </div>
    );
  }

  const counts = snapshot
    ? `${snapshot.nodes.length} nodes · ${snapshot.topics.length} topics · ${journal.length} events`
    : 'loading…';

  return (
    <div className="agentic-flows">
      <FlowCanvas />

      <div className="topbar">
        <div className="brand">
          <div className="mark" />
          <div>
            <b>Agentic Flows</b>
            <span>flowmanager observatory</span>
          </div>
        </div>
        <div className="spacer" />
        <div className="chip" style={{ cursor: 'default' }}>
          <span className={`dot ${connected ? 'ok' : ''}`} />
          {counts}
        </div>
        {TABS.map((t) => (
          <button key={t} className={`chip ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="side">
        {tab === 'emit' && <EmitConsole />}
        {tab === 'journal' && <JournalTail />}
        {tab === 'chain' && <ChainInspector />}
        {tab === 'wiring' && <WiringEditor />}
      </div>

      <div className="hint">drag to pan · scroll to zoom · click a station to open it</div>

      <div
        className={`drawer-scrim ${selectedNode ? 'open' : ''}`}
        onClick={() => selectNode(null)}
      />
      <div className={`drawer ${selectedNode ? 'open' : ''}`}>
        {selectedNode && (
          <>
            <div className="drawer-head">
              <div>
                <div className="eye">flow station</div>
                <h2>{selectedNode.name || '(unnamed)'}</h2>
              </div>
              <button className="drawer-x" onClick={() => selectNode(null)}>
                ✕
              </button>
            </div>
            <div className="drawer-body">
              <NodeInspector />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
