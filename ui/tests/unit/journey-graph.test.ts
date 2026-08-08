import { describe, expect, it } from 'vitest';
import { JourneyGraph } from '@sdk';
import { journeyStep } from '../utils/journey-fixtures';

// The point of these tests is that they need NOTHING: no network, no entity
// registry. Before JourneyGraph existed, none of this behavior could be reached
// without mounting a React component.

const step = (node_id: string, group?: string) => journeyStep(node_id, { group });

describe('JourneyGraph — built in code', () => {
  it('is constructible from steps, with no file and no parse', () => {
    const graph = new JourneyGraph({ steps: [step('a'), step('b')], start: { kind: 'root' } });
    expect(graph.length).toBe(2);
    expect(graph.start).toEqual({ kind: 'root' });
    expect(graph.entry?.node_id).toBe('a');
  });

  it('defaults to an empty graph', () => {
    const graph = new JourneyGraph();
    expect(graph.isEmpty).toBe(true);
    expect(graph.entry).toBeNull();
    expect(graph.start).toBeNull();
  });

  it('walks by node id, and stops at the ends', () => {
    const graph = new JourneyGraph({ steps: [step('a'), step('b')] });
    expect(graph.indexOf('b')).toBe(1);
    expect(graph.stepAt('a')?.node_id).toBe('a');
    expect(graph.next('a')?.node_id).toBe('b');
    // last step and unknown id both have no next
    expect(graph.next('b')).toBeNull();
    expect(graph.next('nope')).toBeNull();
    expect(graph.stepAt('nope')).toBeNull();
    expect(graph.indexOf(undefined)).toBe(-1);
  });
});

describe('JourneyGraph.parse', () => {
  it('reads guided steps in order and ignores every other node type', () => {
    const graph = JourneyGraph.parse(
      JSON.stringify({
        start: { kind: 'root' },
        nodes: [
          { id: 't', node_type: 'trigger' },
          {
            id: 's1',
            node_type: 'guided_step',
            name: 'First',
            node_data: {
              status_line: 'do the thing',
              group: 'G',
              present: { dock: { kind: 'wiki', name: 'W' }, highlight: 'Tag' },
              act: { kind: 'fill', target: 'Tag', text: 'hi' },
              waitFor: [{ input: 'Tag' }],
            },
          },
          { id: 'a', node_type: 'agent' },
        ],
      }),
    );
    expect(graph.length).toBe(1);
    expect(graph.start).toEqual({ kind: 'root' });
    const s = graph.steps[0];
    expect(s.name).toBe('First');
    expect(s.status_line).toBe('do the thing');
    expect(s.group).toBe('G');
    expect(s.present.highlight).toBe('Tag');
    expect(s.act?.kind).toBe('fill');
    expect(s.waitFor).toEqual([{ input: 'Tag' }]);
  });

  it('falls back to the node id for a nameless step and tolerates absent node_data', () => {
    const graph = JourneyGraph.parse(
      JSON.stringify({ nodes: [{ id: 'bare', node_type: 'guided_step' }] }),
    );
    expect(graph.steps[0].name).toBe('bare');
    expect(graph.steps[0].present).toEqual({});
    expect(graph.steps[0].waitFor).toEqual([]);
    expect(graph.start).toBeNull();
  });
});

describe('JourneyGraph.sections', () => {
  it('folds CONSECUTIVE grouped steps and keeps ungrouped ones standalone', () => {
    const graph = new JourneyGraph({
      steps: [step('a'), step('b', 'G1'), step('c', 'G1'), step('d', 'G2'), step('e')],
    });
    expect(graph.sections.map((s) => [s.group, s.indices])).toEqual([
      [null, [0]],
      ['G1', [1, 2]],
      ['G2', [3]],
      [null, [4]],
    ]);
  });

  it('keeps two separate runs of the same group name apart', () => {
    // Authoring order is never silently reordered — a group that reappears
    // later is a second section, not a merge back into the first.
    const graph = new JourneyGraph({ steps: [step('a', 'G'), step('b'), step('c', 'G')] });
    expect(graph.sections.map((s) => s.indices)).toEqual([[0], [1], [2]]);
  });
});

describe('JourneyGraph.problems — the code-built journey has no server to catch typos', () => {
  it('is silent on a well-formed graph', () => {
    const graph = new JourneyGraph({
      steps: [{ ...step('a'), present: { dock: { kind: 'root' } }, act: { kind: 'fill', target: 'T' } }],
    });
    expect(graph.problems()).toEqual([]);
  });

  it('accepts a step with no dock at all (highlight-only presents in place)', () => {
    expect(new JourneyGraph({ steps: [step('a')] }).problems()).toEqual([]);
  });

  it('catches an unknown dock kind, a missing await tag, and a targetless act', () => {
    const graph = new JourneyGraph({
      steps: [
        {
          node_id: 'bad',
          name: 'bad',
          status_line: '',
          present: { dock: { kind: 'nowhere' as never } },
          act: { kind: 'teleport' as never, target: '' },
          waitFor: [],
        },
      ],
    });
    const problems = graph.problems().join('\n');
    expect(problems).toContain('present.dock.kind "nowhere"');
    expect(problems).toContain('waitFor is required');
    expect(problems).toContain('act.kind "teleport"');
    expect(problems).toContain('act.target is required');
  });

  it('catches a duplicate node id', () => {
    const graph = new JourneyGraph({ steps: [step('same'), step('same')] });
    expect(graph.problems().join('\n')).toContain('duplicate node_id');
  });
});
