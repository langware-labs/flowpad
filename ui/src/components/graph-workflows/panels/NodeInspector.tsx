/**
 * Node inspector (atlas drawer body) — per-node_type editing straight into
 * graph.json via the store's mutateDoc:
 * - trigger:  pick the Trigger entity it references (emits `fired`).
 * - agent:    program kind/ref, prompt, model size, execution mode.
 * - function: GraphWorkflowFunction picker (registry-fed) or script path + runtime
 *             toggle + last stdio.
 * Plus shared: rename, delete node (with its edges), last execution status.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTriggers } from '@src/hooks/useTriggers';
import { useAgents } from '@src/hooks/useAgents';
import {
  graphWorkflows,
  functionRuntime,
  type GraphWorkflowDocNode,
  type GraphWorkflowFunctionInfo,
} from '@sdk/services/graph-workflows';
import { asStr, fmtDuration } from '../fmt';
import { useStudio } from '../store';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="afl-field">
      <label>{label}</label>
      {children}
    </div>
  );
}

export function NodeInspector({ node }: { node: GraphWorkflowDocNode }) {
  const mutateDoc = useStudio((s) => s.mutateDoc);
  const selectNode = useStudio((s) => s.selectNode);
  const live = useStudio((s) => s.nodeStatus[node.id]);
  const { triggers } = useTriggers();
  const { agents } = useAgents();

  const patch = useCallback(
    (fn: (n: GraphWorkflowDocNode) => void) => {
      mutateDoc((d) => {
        const target = d.nodes.find((x) => x.id === node.id);
        if (target) fn(target);
        return d;
      });
    },
    [mutateDoc, node.id],
  );

  const nd = node.node_data;
  const setData = (key: string, value: unknown) => patch((n) => (n.node_data[key] = value));

  const deleteNode = () => {
    selectNode(null);
    mutateDoc((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => n.id !== node.id),
      edges: d.edges.filter((e) => e.from.node !== node.id && e.to.node !== node.id),
    }));
  };

  return (
    <div className="afl-inspector">
      <Field label="name">
        <input value={node.name ?? ''} onChange={(e) => patch((n) => (n.name = e.target.value))} />
      </Field>

      {node.node_type === 'trigger' && (
        <Field label="trigger entity">
          <select value={asStr(nd.typeid)} onChange={(e) => setData('typeid', e.target.value)}>
            <option value="">— pick a trigger —</option>
            {triggers.map((t) => (
              <option key={t.id} value={`trigger-${t.id}`}>
                {t.name || t.id}
              </option>
            ))}
          </select>
        </Field>
      )}

      {node.node_type === 'agent' && (
        <>
          <Field label="agent (definition)">
            <select
              value={asStr(nd.typeid)}
              onChange={(e) => setData('typeid', e.target.value)}
            >
              <option value="">— inline (ad-hoc) —</option>
              {agents.map((a) => (
                <option key={a.id} value={`agent-${a.id}`} title={a.description ?? undefined}>
                  {a.name || a.id}
                </option>
              ))}
            </select>
          </Field>
          {asStr(nd.typeid) !== '' && (
            <p className="afl-note">
              The Agent definition's model + system prompt lead; the fields below are
              per-node overrides / task addendum.
            </p>
          )}
          <Field label="program kind">
            <select value={asStr(nd.program_kind) || 'instruction'} onChange={(e) => setData('program_kind', e.target.value)}>
              <option value="instruction">instruction (agent prompt)</option>
              <option value="skill">skill (agent /skill)</option>
            </select>
          </Field>
          <Field label={nd.program_kind === 'skill' ? 'skill name' : 'instruction ref'}>
            <input value={asStr(nd.program_ref)} onChange={(e) => setData('program_ref', e.target.value)} />
          </Field>
          <Field label="prompt (appended to the event payload)">
            <textarea rows={4} value={asStr(nd.prompt)} onChange={(e) => setData('prompt', e.target.value)} />
          </Field>
          <Field label="model size">
            <select value={asStr(nd.model_size) || 'sm'} onChange={(e) => setData('model_size', e.target.value)}>
              <option value="sm">sm → haiku</option>
              <option value="md">md → sonnet</option>
              <option value="lg">lg → opus</option>
            </select>
          </Field>
          <Field label="execution">
            <select value={asStr(nd.execution_mode) || 'serial'} onChange={(e) => setData('execution_mode', e.target.value)}>
              <option value="serial">serial (queue)</option>
              <option value="parallel">parallel</option>
            </select>
          </Field>
          {nd.execution_mode === 'parallel' && (
            <Field label="parallel limit">
              <input
                type="number"
                min={1}
                value={Number(nd.parallel_limit ?? 1)}
                onChange={(e) => setData('parallel_limit', Math.max(1, Number(e.target.value) || 1))}
              />
            </Field>
          )}
          <Field label="merge identical queued events">
            <input type="checkbox" checked={!!nd.merge_identical} onChange={(e) => setData('merge_identical', e.target.checked)} />
          </Field>
        </>
      )}

      {node.node_type === 'function' && (
        <>
          <FunctionPicker node={node} setData={setData} />
          {(live?.lastStdout || live?.lastStderr || live?.lastExitCode !== undefined) && (
            <div className="afl-stdio">
              <div className="eye">
                last run{live?.lastExitCode !== undefined ? ` · exit ${live.lastExitCode}` : ''}
                {live?.lastDurationMs ? ` · ${fmtDuration(live.lastDurationMs)}` : ''}
              </div>
              {live?.lastStdout && <pre className="out">{live.lastStdout}</pre>}
              {live?.lastStderr && <pre className="err">{live.lastStderr}</pre>}
            </div>
          )}
        </>
      )}

      {live?.error && <div className="afl-status warn">✗ {live.error}</div>}

      <button className="afl-danger" onClick={deleteNode}>
        Delete node
      </button>
    </div>
  );
}

/**
 * GraphWorkflowFunction reference editor: a registry-fed picker (name + meaning —
 * typos die at wiring time) OR a flow-folder script path, plus the runtime
 * toggle. Script + inline is invalid (flow-folder code never runs in the
 * server process) — picking a script forces subprocess.
 */
function FunctionPicker({
  node,
  setData,
}: {
  node: GraphWorkflowDocNode;
  setData: (key: string, value: unknown) => void;
}) {
  const [registry, setRegistry] = useState<GraphWorkflowFunctionInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    void graphWorkflows
      .listFunctions()
      .then((fns) => {
        if (!cancelled && fns) setRegistry(fns);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const ref = asStr(node.node_data.function);
  const isScript = ref.endsWith('.py');
  const runtime = functionRuntime(node);
  const selectedMeaning = registry.find((f) => f.name === ref)?.meaning;

  return (
    <>
      <Field label="function (registry)">
        <select
          value={isScript ? '' : ref}
          onChange={(e) => {
            if (e.target.value) setData('function', e.target.value);
          }}
        >
          <option value="">{isScript ? '— using a script —' : '— pick a function —'}</option>
          {registry.map((f) => (
            <option key={f.name} value={f.name} title={f.meaning ?? undefined}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>
      {selectedMeaning && <p className="afl-note">{selectedMeaning}</p>}
      <Field label="or script (relative to the flow folder)">
        <input
          value={isScript ? ref : ''}
          placeholder="scripts/my_node.py"
          onChange={(e) => {
            setData('function', e.target.value);
            if (e.target.value.endsWith('.py')) setData('runtime', 'subprocess');
          }}
        />
      </Field>
      <Field label="runtime">
        <select
          value={runtime}
          onChange={(e) => setData('runtime', e.target.value)}
        >
          <option value="inline" disabled={isScript}>
            inline (server loop — fast, direct SDK)
          </option>
          <option value="subprocess">subprocess (isolated, full stdio record)</option>
        </select>
      </Field>
      <p className="afl-note">
        Contract: <code>on_graph_workflow_event(event_name, data, flow_ctx)</code> — a dict return
        auto-emits <code>done</code>; emit more via <code>flow_ctx.emit_flow_event(key, value)</code>.
      </p>
    </>
  );
}
