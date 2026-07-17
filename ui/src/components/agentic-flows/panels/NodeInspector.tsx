/**
 * Node inspector — the atlas reading-drawer content for a selected flow node:
 * meta grid, editable program + prompt, live status, executions with agent
 * output, and the node's events. Rendered inside .drawer by AgenticFlowsView.
 */
import { useEffect, useState } from 'react';
import apiClient from '@sdk/client';
import { flowManager, topicMatches } from '@sdk/services/flow-manager';
import { fmtDuration, fmtRelative, nodeStatusLine, parseIsoMs } from '../fmt';
import { useStudio, type ExecutionEntry } from '../store';

// Stable empty reference — an inline `?? []` in a zustand selector returns a
// fresh array every snapshot check and loops useSyncExternalStore forever.
const NO_EXECUTIONS: ExecutionEntry[] = [];

interface TranscriptEntry {
  kind?: string;
  text?: string;
}

/** Assistant output from a transcript/full payload: every non-empty
 * `assistant_message.text`, in order. */
function extractOutput(entries: TranscriptEntry[]): string {
  return entries
    .filter((e) => e.kind === 'assistant_message' && typeof e.text === 'string' && e.text.trim())
    .map((e) => (e.text as string).trim())
    .join('\n---\n');
}

function Execution({ ex }: { ex: ExecutionEntry }) {
  const openProcess = useStudio((s) => s.openProcess);
  const [output, setOutput] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now] = useState(() => Date.now());

  const fetchOutput = async () => {
    if (!ex.processId) return;
    setLoading(true);
    try {
      const data = await apiClient.post<{ entries?: TranscriptEntry[] }>(
        `/graph/agentic_process/${ex.processId}/transcript/full`,
        {},
      );
      setOutput(extractOutput(data?.entries ?? []) || '(no assistant output found)');
    } catch (e) {
      setOutput(`failed to load output: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  const icon = ex.phase === 'running' ? '▶' : ex.phase === 'failed' ? '✗' : '✓';
  const color =
    ex.phase === 'running' ? 'var(--rubric)' : ex.phase === 'failed' ? 'var(--afl-err)' : 'var(--ink-soft)';
  return (
    <div className="hop" style={{ borderColor: color }}>
      <div className="row" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
        <span style={{ color }}>{icon}</span>
        <b>{ex.topic}</b>
        <span className="faint">
          {ex.durationMs ? fmtDuration(ex.durationMs) : ex.phase} · {fmtRelative(ex.startedAt, now)}
        </span>
        {ex.processId && (
          <a
            style={{ marginLeft: 'auto', color: 'var(--rubric)', cursor: 'pointer' }}
            onClick={() => openProcess?.(ex.processId!)}
          >
            open ⬈
          </a>
        )}
      </div>
      {ex.error && <div className="err">✗ {ex.error}</div>}
      {ex.processId && ex.phase !== 'running' && output === null && (
        <button className="mini" onClick={fetchOutput} disabled={loading} style={{ marginTop: 4 }}>
          {loading ? 'loading…' : 'show output'}
        </button>
      )}
      {output !== null && <pre>{output}</pre>}
    </div>
  );
}

export function NodeInspector() {
  const nodeId = useStudio((s) => s.selectedNodeId);
  const snapshot = useStudio((s) => s.snapshot);
  const setSnapshot = useStudio((s) => s.setSnapshot);
  const live = useStudio((s) => (nodeId ? s.nodeStatus[nodeId] : undefined));
  const proc = useStudio((s) => (live?.processId ? s.procStatus[live.processId] : undefined));
  const executions = useStudio((s) =>
    nodeId ? (s.executions[nodeId] ?? NO_EXECUTIONS) : NO_EXECUTIONS,
  );
  const journal = useStudio((s) => s.journal);

  const node = snapshot?.nodes.find((n) => n.id === nodeId);
  const [programRef, setProgramRef] = useState('');
  const [prompt, setPrompt] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 3000);
    return () => clearInterval(id);
  }, []);

  // Re-seed editors when switching nodes (not on background snapshot refreshes
  // while the user is mid-edit).
  useEffect(() => {
    if (!node) return;
    setProgramRef(node.program_ref ?? '');
    setPrompt(node.prompt ?? '');
    setDirty(false);
    setSaveStatus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  if (!nodeId || !node) return null;

  const save = async () => {
    setSaveStatus(null);
    try {
      await apiClient.put(`/graph/flow_node/${nodeId}`, {
        program_ref: programRef,
        prompt: prompt || null,
      });
      const snap = await flowManager.fetchGraph();
      if (snap) setSnapshot(snap);
      setDirty(false);
      setSaveStatus('saved ✓');
    } catch (e) {
      setSaveStatus(String(e));
    }
  };

  const listens = (snapshot?.edges ?? [])
    .filter((e) => e.kind === 'listens' && e.node_id === nodeId)
    .map((e) => e.topic);
  const events = [...journal]
    .reverse()
    .map((e) => {
      const received = listens.some((t) => topicMatches(t, e.topic));
      const emitted = e.source === `flow_node:${nodeId}`;
      return received || emitted ? { e, dir: emitted ? 'out' : 'in' } : null;
    })
    .filter(Boolean)
    .slice(0, 15) as Array<{ e: (typeof journal)[number]; dir: 'in' | 'out' }>;

  const statusLine = nodeStatusLine(live, proc?.workerStatus, now);

  return (
    <>
      <div className="d-meta">
        <div className="m">
          <div className="k">program</div>
          <div className="v">{node.program_kind}</div>
        </div>
        <div className="m">
          <div className="k">delivery</div>
          <div className="v">{node.delivery_mode}</div>
        </div>
        <div className="m">
          <div className="k">execution</div>
          <div className="v">
            {node.execution_mode === 'parallel' ? `parallel ×${node.parallel_limit}` : 'serial'}
          </div>
        </div>
        <div className="m">
          <div className="k">model</div>
          <div className="v">{node.model_size ?? 'sm'}</div>
        </div>
        <div className="m">
          <div className="k">status</div>
          <div className="v stl" style={{ color: statusLine.color }}>
            {statusLine.text}
          </div>
        </div>
      </div>

      <label>
        {node.program_kind === 'skill'
          ? 'Skill'
          : node.program_kind === 'callback'
            ? 'Callback'
            : 'Instructions'}
      </label>
      <textarea
        rows={node.program_kind === 'instruction' ? 5 : 1}
        value={programRef}
        onChange={(e) => {
          setProgramRef(e.target.value);
          setDirty(true);
        }}
      />
      <label>Prompt (appended on delivery)</label>
      <textarea
        rows={3}
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
          setDirty(true);
        }}
        placeholder="e.g. keep it under 10 words"
      />
      <div className="row">
        <button className="primary" onClick={save} disabled={!dirty}>
          Save
        </button>
        {saveStatus && <span className="faint">{saveStatus}</span>}
      </div>

      <h3>Executions</h3>
      {executions.length === 0 && <div className="faint">none this session</div>}
      {executions.map((ex, i) => (
        <Execution key={`${ex.startedAt}-${i}`} ex={ex} />
      ))}

      <h3>Events</h3>
      {events.length === 0 && <div className="faint">nothing heard or emitted yet</div>}
      <table>
        <tbody>
          {events.map(({ e, dir }, i) => (
            <tr key={`${e.ts}-${i}`}>
              <td style={{ color: dir === 'out' ? 'var(--afl-warn)' : 'var(--flow-hot)', width: 20 }}>
                {dir === 'out' ? '↗' : '↘'}
              </td>
              <td>{e.topic}</td>
              <td className="faint" style={{ whiteSpace: 'nowrap' }}>
                {fmtRelative(parseIsoMs(e.ts), now)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
