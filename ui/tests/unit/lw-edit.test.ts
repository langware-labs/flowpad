// An edit made on a statements card, written into the block's YAML (docs/lw.md).
import { describe, expect, it } from 'vitest';
import { applyLwEdit } from '@src/components/milkdown-editor/plugins/fence-render/renderers/lw-edit';

const BLOCK = `tag: machine_access.model # the model
statements:
  - text: 'A connected machine is a connected machine. Single model: a compute node represents a machine.'
    basis: stated # stated | proven
    issues:
      - "No worker is started."
    about: ["flow_sdk/core/compute/hub_node.py:158"]
  - text: A machine has one id.
`;

describe('editing a statement on its card', () => {
  it('changes that sentence and leaves the rest of the block as it was, comments included', () => {
    const next = applyLwEdit(BLOCK, { statement: 1, text: 'A machine has exactly one id.' });
    expect(next).toBe(BLOCK.replace('A machine has one id.', 'A machine has exactly one id.'));
  });

  it('writes a long sentence on one line, as typed', () => {
    const text = `A connected machine ${'is a connected machine, '.repeat(12)}and nothing else: one model.`;
    const next = applyLwEdit(BLOCK, { statement: 1, text });
    expect(next.split('\n').filter((line) => line.includes('one model.'))).toHaveLength(1);
    expect(next).toContain('# stated | proven');
  });

  it('does nothing for a statement that is not there, or a block that does not parse', () => {
    expect(applyLwEdit(BLOCK, { statement: 7, text: 'x' })).toBe(BLOCK);
    expect(applyLwEdit('tag: [a\nstatements:', { statement: 0, text: 'x' })).toBe('tag: [a\nstatements:');
  });
});
