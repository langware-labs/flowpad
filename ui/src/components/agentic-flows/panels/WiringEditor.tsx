/** Wiring editor — create FlowNodes and Topics; wire Listens via the canvas
 * (drag) or here by name. Persists through the SDK entity layer. */
import { useState } from 'react';
import apiClient from '@sdk/client';
import { FlowNode, Topic } from '@sdk/entities';
import { flowManager } from '@sdk/services/flow-manager';
import { useStudio } from '../store';

export function WiringEditor() {
  const snapshot = useStudio((s) => s.snapshot);
  const setSnapshot = useStudio((s) => s.setSnapshot);
  const [name, setName] = useState('');
  const [programKind, setProgramKind] = useState<'callback' | 'skill' | 'instruction'>('instruction');
  const [programRef, setProgramRef] = useState('');
  const [delivery, setDelivery] = useState<'spawn' | 'inject'>('spawn');
  const [execMode, setExecMode] = useState<'serial' | 'parallel'>('serial');
  const [parallelLimit, setParallelLimit] = useState(3);
  const [mergeIdentical, setMergeIdentical] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [modelSize, setModelSize] = useState<'sm' | 'md' | 'lg'>('sm');
  const [workdir, setWorkdir] = useState('');
  const [listenTopic, setListenTopic] = useState('');
  const [newTopic, setNewTopic] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  const refresh = async () => {
    const snap = await flowManager.fetchGraph();
    if (snap) setSnapshot(snap);
  };

  const createNode = async () => {
    setStatus(null);
    if (!name || !programRef) {
      setStatus('name and program are required');
      return;
    }
    try {
      const node = new FlowNode({
        name,
        program_kind: programKind,
        program_ref: programRef,
        delivery_mode: delivery,
        execution_mode: execMode,
        parallel_limit: parallelLimit,
        merge_identical: mergeIdentical,
        prompt: prompt || undefined,
        model_size: modelSize,
        workdir: workdir || undefined,
      });
      await node.save();
      if (listenTopic) {
        await apiClient.post(`/graph/flow_node/${node.id}/wire`, { topic_name: listenTopic });
      }
      setStatus(`node "${name}" created${listenTopic ? ` listening on ${listenTopic}` : ''}`);
      setName('');
      setProgramRef('');
      await refresh();
    } catch (e) {
      setStatus(String(e));
    }
  };

  const createTopic = async () => {
    setStatus(null);
    if (!newTopic) return;
    try {
      // Emitting mints the topic (and ancestors) without dispatching listeners
      // that don't exist yet — the cheapest "create topic" there is.
      await flowManager.emitTopic(newTopic, { minted_by: 'agentic-flows' });
      setNewTopic('');
      await refresh();
    } catch (e) {
      setStatus(String(e));
    }
  };

  return (
    <div className="">
      <h3>New topic</h3>
      <div className="row">
        <input
          placeholder="a.b.c"
          value={newTopic}
          onChange={(e) => setNewTopic(e.target.value)}
        />
        <button className="mini" onClick={createTopic}>Mint</button>
      </div>

      <h3>New flow node</h3>
      <label>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <label>Program</label>
      <div className="row">
        <select value={programKind} onChange={(e) => setProgramKind(e.target.value as never)}>
          <option value="callback">callback</option>
          <option value="skill">skill</option>
          <option value="instruction">instruction</option>
        </select>
        <select value={delivery} onChange={(e) => setDelivery(e.target.value as never)}>
          <option value="spawn">spawn</option>
          <option value="inject">inject</option>
        </select>
      </div>
      <textarea
        rows={3}
        placeholder={
          programKind === 'callback'
            ? 'registered callback name'
            : programKind === 'skill'
              ? 'skill name'
              : 'instruction text for the spawned agent'
        }
        value={programRef}
        onChange={(e) => setProgramRef(e.target.value)}
      />
      {programKind !== 'callback' && (
        <>
          <label>Prompt (appended to the program)</label>
          <textarea
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. keep it under 10 words"
          />
          <label>Model size</label>
          <div className="row">
            {(['sm', 'md', 'lg'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setModelSize(s)}
                className="mini"
                style={{
                  flex: 1,
                  background: modelSize === s ? '#4c6ef5' : '#3a3f52',
                  marginTop: 0,
                }}
                title={s === 'sm' ? 'haiku — fast/cheap (testing)' : s === 'md' ? 'sonnet' : 'opus'}
              >
                {s}
              </button>
            ))}
          </div>
        </>
      )}
      <label>Execution</label>
      <div className="row">
        <select value={execMode} onChange={(e) => setExecMode(e.target.value as never)}>
          <option value="serial">serial — one by one</option>
          <option value="parallel">parallel</option>
        </select>
        {execMode === 'parallel' && (
          <input
            type="number"
            min={1}
            max={32}
            value={parallelLimit}
            onChange={(e) => setParallelLimit(Math.max(1, Number(e.target.value) || 1))}
            title="max concurrent executions"
            style={{ width: 70 }}
          />
        )}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={mergeIdentical}
          onChange={(e) => setMergeIdentical(e.target.checked)}
          style={{ width: 'auto' }}
        />
        merge identical pending events
      </label>
      <label>Workdir (optional)</label>
      <input value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="/path/to/project" />
      <label>Listen on topic (optional)</label>
      <input
        list="topic-names-w"
        value={listenTopic}
        onChange={(e) => setListenTopic(e.target.value)}
        placeholder="a.b — hears whole subtree"
      />
      <datalist id="topic-names-w">
        {snapshot?.topics.map((t) => <option key={t.id} value={t.name} />)}
      </datalist>
      <button className="primary" onClick={createNode}>Create node</button>
      {status && <div className="faint">{status}</div>}
    </div>
  );
}
