/**
 * Atlas-language node renderers for the v2 flow canvas:
 * - TriggerNode — distinct output-only shape (angled pill, single source
 *   handle) referencing a Trigger entity; emits `fired`.
 * - StationCard — agent / function atlas .card: mono kicker + pip,
 *   serif title, live status line, model-size selector (agents), inline vs
 *   subprocess badge (functions), heartbeat while running, active/queued badges.
 */
import { useEffect, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { functionRuntime, type FlowDocNode } from '@sdk/services/agentic-flows';
import { asStr, nodeStatusLine } from '../fmt';
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

function useLive(nodeId: string) {
  const live = useStudio((s) => s.nodeStatus[nodeId]);
  const proc = useStudio((s) => (live?.processId ? s.procStatus[live.processId] : undefined));
  const running = (live?.active ?? 0) > 0;
  const now = useNow(running);
  return { live, proc, running, now };
}

export function TriggerNode({ data, selected }: NodeProps) {
  const def = (data as { def: FlowDocNode }).def;
  const typeid = asStr(def.node_data.typeid);
  const { live, running } = useLive(def.id);

  return (
    <div className={['afl-trigger', selected ? 'selected' : '', running ? 'running' : ''].join(' ')}>
      <div className="card">
        <div className="kic">
          <span className="pip trigger" />
          trigger
        </div>
        <div className="ttl">{def.name || '(unnamed trigger)'}</div>
        <div className="sub" title={typeid}>
          {typeid || 'no trigger linked'}
        </div>
        <div className="evt">fired ⟶</div>
        {(live?.active ?? 0) > 0 && <span className="deg">▶{live?.active}</span>}
        <Handle type="source" position={Position.Right} />
      </div>
    </div>
  );
}

export function StationCard({ data, selected }: NodeProps) {
  const def = (data as { def: FlowDocNode }).def;
  const nd = def.node_data as {
    program_kind?: string;
    program_ref?: string;
    prompt?: string;
    model_size?: string;
    execution_mode?: string;
    parallel_limit?: number;
    merge_identical?: boolean;
    function?: string;
    typeid?: string;
  };
  const isFunction = def.node_type === 'function';
  const runtime = isFunction ? functionRuntime(def) : '';
  const kind = isFunction ? `function · ${runtime}` : nd.program_kind || 'instruction';
  const isAgent = !isFunction;

  const { live, proc, running, now } = useLive(def.id);
  const openProcess = useStudio((s) => s.openProcess);
  const mutateDoc = useStudio((s) => s.mutateDoc);

  const failed = !running && !!live?.error;
  const statusLine = nodeStatusLine(live, proc?.workerStatus, now);
  const execBadge = nd.execution_mode === 'parallel' ? `∥×${nd.parallel_limit ?? 1}` : 'serial';
  const modelSize = nd.model_size ?? 'sm';

  const changeModelSize = (size: string) => {
    mutateDoc((d) => {
      const n = d.nodes.find((x) => x.id === def.id);
      if (n) n.node_data.model_size = size;
      return d;
    });
  };

  const agentRef = !isFunction && typeof nd.typeid === 'string' && nd.typeid.startsWith('agent-')
    ? nd.typeid.slice('agent-'.length)
    : '';
  const sub = isFunction
    ? nd.function || 'no function'
    : agentRef
      ? `⚙ ${agentRef.slice(0, 8)}${nd.prompt ? ' + prompt' : ''}`
      : nd.program_kind === 'skill'
        ? `/${nd.program_ref}`
        : nd.program_ref || nd.prompt || '';

  return (
    <div className={['afl-node', selected ? 'selected' : '', running ? 'running' : '', failed ? 'failed' : ''].join(' ')}>
      <div className="card">
        <Handle type="target" position={Position.Left} />
        <div className="kic">
          <span className={`pip ${isFunction ? 'function' : nd.program_kind || 'instruction'}`} />
          {kind} · {execBadge}
          {nd.merge_identical ? ' · ⧉' : ''}
          {isAgent && (
            <span className="sizes nodrag">
              {MODEL_SIZES.map((size) => (
                <button
                  key={size}
                  className={modelSize === size ? 'on' : ''}
                  title={MODEL_TITLES[size]}
                  onClick={(e) => {
                    e.stopPropagation();
                    changeModelSize(size);
                  }}
                >
                  {size}
                </button>
              ))}
            </span>
          )}
        </div>
        <div className="ttl">{def.name || '(unnamed)'}</div>
        <div className="sub" title={nd.prompt || sub}>
          {sub}
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
