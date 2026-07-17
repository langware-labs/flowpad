/**
 * Node inspector (atlas drawer body) — per-node_type editing straight into
 * graph.json via the store's mutateDoc:
 * - trigger:        pick the Trigger entity it references (emits `fired`).
 * - process_runner: program kind/ref, prompt, model size, execution mode.
 * - pysdk:          script path (relative to the flow folder) + last stdio.
 * Plus shared: rename, delete node (with its edges), last execution status.
 */
import { useCallback } from 'react';
import { useTriggers } from '@src/hooks/useTriggers';
import type { FlowDocNode } from '@sdk/services/agentic-flows';
import { fmtDuration } from '../fmt';
import { useStudio } from '../store';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="afl-field">
      <label>{label}</label>
      {children}
    </div>
  );
}

export function NodeInspector({ node }: { node: FlowDocNode }) {
  const mutateDoc = useStudio((s) => s.mutateDoc);
  const selectNode = useStudio((s) => s.selectNode);
  const live = useStudio((s) => s.nodeStatus[node.id]);
  const { triggers } = useTriggers();

  const patch = useCallback(
    (fn: (n: FlowDocNode) => void) => {
      mutateDoc((d) => {
        const target = d.nodes.find((x) => x.id === node.id);
        if (target) fn(target);
        return d;
      });
    },
    [mutateDoc, node.id],
  );

  const nd = node.node_data as Record<string, unknown>;
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
          <select value={String(nd.typeid ?? '')} onChange={(e) => setData('typeid', e.target.value)}>
            <option value="">— pick a trigger —</option>
            {triggers.map((t) => (
              <option key={t.id} value={`trigger-${t.id}`}>
                {t.name || t.id}
              </option>
            ))}
          </select>
        </Field>
      )}

      {node.node_type === 'process_runner' && (
        <>
          <Field label="program kind">
            <select value={String(nd.program_kind ?? 'instruction')} onChange={(e) => setData('program_kind', e.target.value)}>
              <option value="instruction">instruction (agent prompt)</option>
              <option value="skill">skill (agent /skill)</option>
              <option value="callback">callback (in-process python)</option>
            </select>
          </Field>
          <Field label={nd.program_kind === 'callback' ? 'callback name' : nd.program_kind === 'skill' ? 'skill name' : 'instruction ref'}>
            <input value={String(nd.program_ref ?? '')} onChange={(e) => setData('program_ref', e.target.value)} />
          </Field>
          {nd.program_kind !== 'callback' && (
            <>
              <Field label="prompt (appended to the event payload)">
                <textarea rows={4} value={String(nd.prompt ?? '')} onChange={(e) => setData('prompt', e.target.value)} />
              </Field>
              <Field label="model size">
                <select value={String(nd.model_size ?? 'sm')} onChange={(e) => setData('model_size', e.target.value)}>
                  <option value="sm">sm → haiku</option>
                  <option value="md">md → sonnet</option>
                  <option value="lg">lg → opus</option>
                </select>
              </Field>
            </>
          )}
          <Field label="execution">
            <select value={String(nd.execution_mode ?? 'serial')} onChange={(e) => setData('execution_mode', e.target.value)}>
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

      {node.node_type === 'pysdk' && (
        <>
          <Field label="script (relative to the flow folder)">
            <input
              value={String(nd.script ?? '')}
              placeholder="scripts/my_node.py"
              onChange={(e) => setData('script', e.target.value)}
            />
          </Field>
          <p className="afl-note">
            The file must define <code>on_flow_event(event_name, data, flow_ctx)</code>; emit with{' '}
            <code>flow_ctx.emit_flow_event(key, value)</code>.
          </p>
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
