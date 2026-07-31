/**
 * Atlas-language node renderers for the v2 flow canvas:
 * - TriggerNode — distinct output-only shape (angled pill, single source
 *   handle) referencing a Trigger entity; emits `fired`.
 * - StationCard — agent / function atlas .card: mono kicker + pip,
 *   serif title, live status line, model-size selector (agents), inline vs
 *   subprocess badge (functions), heartbeat while running, active/queued badges.
 * - InletNode — a bus subscription or the `$external` injection door: what
 *   FEEDS this flow from outside it. Synthesized from `graph.json`, never a
 *   real node, so it carries no status of its own — it pulses when a matching
 *   event arrives.
 */
import { useEffect, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { functionRuntime, type GraphWorkflowDocNode } from '@sdk/services/graph-workflows';
import { asStr, nodeStatusLine } from '../fmt';
import { useStudio } from '../store';

/** Payload the canvas synthesizes for an inlet. */
export interface InletData {
  /** Bus pattern, or `$external` for the injection door. */
  label: string;
  target?: string;
  external?: boolean;
}

export function InletNode({ data, selected, id }: NodeProps) {
  const inlet = data as unknown as InletData;
  const hot = useStudio((s) => s.hot.has(id));
  const dot = inlet.label.lastIndexOf('.');
  // Dim everything up to the last segment so the eye lands on the verb.
  const prefix = dot > 0 ? inlet.label.slice(0, dot + 1) : '';
  const leaf = dot > 0 ? inlet.label.slice(dot + 1) : inlet.label;

  return (
    <div
      className={[
        'afl-tag',
        selected ? 'selected' : '',
        hot ? 'hot' : '',
        inlet.external ? 'external' : '',
      ].join(' ')}
      title={inlet.target ? `${inlet.label} → target ${inlet.target}` : inlet.label}
    >
      <div className="card">
        <div className="ttl">
          {prefix && <span className="pfx">{prefix}</span>}
          {leaf}
        </div>
        {inlet.target && <div className="tgt">{inlet.target}</div>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

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
  const def = (data as { def: GraphWorkflowDocNode }).def;
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
  const def = (data as { def: GraphWorkflowDocNode }).def;
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
  const previewRuns = useStudio((s) => s.previewRuns);
  const flowId = useStudio((s) => s.flowId);
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

  const agentRef = !isFunction && typeof nd.typeid === 'string' && nd.typeid.startsWith('subagent-')
    ? nd.typeid.slice('subagent-'.length)
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
        <div className={`stl stl-${statusLine.tone}`} title={live?.error || statusLine.text}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{statusLine.text}</span>
          {live?.processId && running && (
            <a
              className="lnk nodrag"
              title="show this station's runs"
              onClick={(e) => {
                e.stopPropagation();
                previewRuns?.({
                  scope: flowId ? { flow_id: flowId, node_id: def.id } : { node_id: def.id },
                  runId: live.processId,
                  title: def.name || def.id,
                });
              }}
            >
              runs ⬈
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
