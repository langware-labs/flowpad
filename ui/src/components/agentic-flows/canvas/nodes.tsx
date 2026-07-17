/**
 * Atlas-language node renderers for the Agentic Flows canvas:
 * - FlowNodeCard — atlas .card: mono kicker (program kind + colored pip),
 *   serif title, italic sub, .deg badges (active/queued), live status line,
 *   sm/md/lg selector, heartbeat ring while running.
 * - TopicPill — atlas .section pill; selecting opens the inline emit popover.
 */
import { useEffect, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import apiClient from '@sdk/client';
import { flowManager } from '@sdk/services/flow-manager';
import { nodeStatusLine } from '../fmt';
import { useStudio } from '../store';

const MODEL_SIZES = ['sm', 'md', 'lg'] as const;
const MODEL_TITLES: Record<string, string> = {
  sm: 'sm → haiku (fast/cheap — testing)',
  md: 'md → sonnet',
  lg: 'lg → opus',
};

/** 1s ticker, running only while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function FlowNodeCard({ data, selected }: NodeProps) {
  const d = data as {
    id?: string;
    name?: string;
    program_kind?: string;
    program_ref?: string;
    prompt?: string;
    model_size?: string;
    delivery_mode?: string;
    execution_mode?: string;
    parallel_limit?: number;
    merge_identical?: boolean;
    enabled?: boolean;
  };
  const live = useStudio((s) => (d.id ? s.nodeStatus[d.id] : undefined));
  const proc = useStudio((s) =>
    live?.processId ? s.procStatus[live.processId] : undefined,
  );
  const openProcess = useStudio((s) => s.openProcess);
  const setSnapshot = useStudio((s) => s.setSnapshot);
  const [modelSize, setModelSize] = useState(d.model_size ?? 'sm');
  const isAgent = d.program_kind !== 'callback';

  const running = (live?.active ?? 0) > 0;
  const failed = !running && !!live?.error;
  const now = useNow(running);
  const statusLine = nodeStatusLine(live, proc?.workerStatus, now);

  const execBadge =
    d.execution_mode === 'parallel' ? `∥×${d.parallel_limit ?? 1}` : 'serial';

  const changeModelSize = async (size: string) => {
    setModelSize(size);
    try {
      await apiClient.put(`/graph/flow_node/${d.id}`, { model_size: size });
      const snap = await flowManager.fetchGraph();
      if (snap) setSnapshot(snap);
    } catch (e) {
      console.error('model_size update failed', e);
      setModelSize(d.model_size ?? 'sm');
    }
  };

  return (
    <div
      className={[
        'afl-node',
        selected ? 'selected' : '',
        running ? 'running' : '',
        failed ? 'failed' : '',
      ].join(' ')}
      style={{ opacity: d.enabled === false ? 0.45 : 1 }}
    >
      <div className="card">
        <Handle type="target" position={Position.Left} />
        <div className="kic">
          <span className={`pip ${d.program_kind ?? ''}`} />
          {d.program_kind} · {d.delivery_mode} · {execBadge}
          {d.merge_identical ? ' · ⧉' : ''}
          {isAgent && (
            <span className="sizes nodrag">
              {MODEL_SIZES.map((size) => (
                <button
                  key={size}
                  className={modelSize === size ? 'on' : ''}
                  title={MODEL_TITLES[size]}
                  onClick={(e) => {
                    e.stopPropagation();
                    void changeModelSize(size);
                  }}
                >
                  {size}
                </button>
              ))}
            </span>
          )}
        </div>
        <div className="ttl">{d.name || '(unnamed)'}</div>
        <div className="sub" title={d.prompt || d.program_ref}>
          {d.program_kind === 'skill' ? `/${d.program_ref}` : d.program_ref}
        </div>
        <div className="stl" style={{ color: statusLine.color }} title={live?.error || statusLine.text}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{statusLine.text}</span>
          {live?.processId && running && (
            <a
              className="lnk nodrag"
              title={`open process ${live.processId}`}
              onClick={(e) => {
                e.stopPropagation();
                openProcess?.(live.processId!);
              }}
            >
              proc ⬈
            </a>
          )}
        </div>
        {(live?.active ?? 0) > 0 && (
          <span className="deg" title={`${live?.active} execution(s) in flight`}>
            ▶{live?.active}
          </span>
        )}
        {(live?.queued ?? 0) > 0 && (
          <span className="deg queued" title={`${live?.queued} event(s) queued`}>
            ⏳{live?.queued}
          </span>
        )}
        <Handle type="source" position={Position.Right} />
      </div>
    </div>
  );
}

export function TopicPill({ data, selected }: NodeProps) {
  const d = data as { id?: string; name?: string };
  const pushSelect = useStudio((s) => s.selectCorrelation);
  const [payload, setPayload] = useState('{}');
  const [status, setStatus] = useState<string | null>(null);
  const segments = (d.name ?? '').split('.');

  const emit = async () => {
    setStatus(null);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = payload.trim() ? JSON.parse(payload) : {};
    } catch {
      setStatus('bad JSON');
      return;
    }
    try {
      const routed = await flowManager.emitTopic(d.name ?? '', parsed);
      if (routed) {
        pushSelect(routed.correlation_id);
        setStatus(routed.dropped ? `⛔ ${routed.dropped}` : `▶ ${routed.correlation_id.slice(0, 8)}`);
      }
    } catch (e) {
      setStatus(String(e));
    }
  };

  return (
    <div className={`afl-topic ${selected ? 'selected' : ''}`} style={{ width: 188 }}>
      <div className="card">
        <Handle type="target" position={Position.Left} />
        <div className="ttl" title={d.name}>
          <span className="pfx">{segments.slice(0, -1).map((s) => `${s}.`).join('')}</span>
          {segments.at(-1)}
        </div>
        <Handle type="source" position={Position.Right} />
      </div>
      {selected && (
        <div className="afl-emitpop nodrag nopan nowheel">
          <textarea
            rows={3}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            placeholder="payload JSON"
            style={{
              width: '100%',
              background: 'var(--paper-2)',
              color: 'var(--ink-strong)',
              border: '1px solid var(--afl-edge)',
              borderRadius: 6,
              padding: 6,
              fontSize: 11,
              fontFamily: 'var(--mono)',
            }}
          />
          <button
            onClick={emit}
            style={{
              marginTop: 5,
              width: '100%',
              background: 'var(--rubric)',
              color: 'var(--paper)',
              border: 'none',
              borderRadius: 6,
              padding: '5px 0',
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            Emit ▶
          </button>
          {status && (
            <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 4, fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
              {status}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
