// lw (langware) block schema — TS side of the cross-language contract.
// tests/fixtures/lw_blocks_contract.json is ALSO read by tests/unit/test_lw.py
// (flow_sdk/schema/data_spec/lw_spec.py). The two suites pin one answer to
// "is this block valid". Change the fixture only with both suites in hand.
import { formatSiteLabel } from '@src/components/milkdown-editor/plugins/fence-render/renderers/breadcrumb-schema';
import { describe, expect, it } from 'vitest';
import {
  parseLwBlock,
  validateLwBlock,
  type LwBlockKind,
} from '@src/components/milkdown-editor/plugins/fence-render/renderers/lw-schema';
import contract from '../../../tests/fixtures/lw_blocks_contract.json';

describe('lw block schema (shared fixture)', () => {
  for (const c of contract.cases) {
    it(`${c.ok ? 'accepts' : 'rejects'}: ${c.name}`, () => {
      const run = () => validateLwBlock(c.kind as LwBlockKind, c.body);
      if (c.ok) expect(run).not.toThrow();
      else expect(run).toThrow();
    });
  }
});

describe('parseLwBlock', () => {
  it('normalizes a statements block for the card', () => {
    const block = parseLwBlock(
      'statements',
      [
        'tag: machine_access.remote_control',
        'depends_on:',
        '  - machine_access.privileged_access',
        'statements:',
        '  - text: Remote control is flow connect with a node created locked.',
        '    basis: stated',
        '    issues:',
        '      - No node carries a "locked" setting.',
        '    about:',
        '      - flow_sdk/core/compute/hub_node.py:46',
        '  - text: A statement with nothing else passes.',
      ].join('\n'),
    );
    expect(block.tag).toBe('machine_access.remote_control');
    expect(block.dependsOn).toEqual(['machine_access.privileged_access']);
    expect(block.statements[0].issues).toEqual(['No node carries a "locked" setting.']);
    expect(formatSiteLabel(block.statements[0].about[0])).toBe('flow_sdk/core/compute/hub_node.py:46');
    expect(block.statements[1]).toEqual({ text: 'A statement with nothing else passes.', basis: undefined, issues: [], about: [] });
  });

  it('reads the requirements of a statements block as their sentences', () => {
    const block = parseLwBlock('statements', 'tag: a.b\nstatements:\n  - text: It is so.\nrequirements:\n  - text: Build it.\n');
    expect(block.requirements).toEqual(['Build it.']);
  });

  it('names the field that is wrong', () => {
    expect(() => parseLwBlock('statements', 'tag: a\nstatements:\n  - id: S1\n    text: x\n')).toThrow('statements.0: a statement has no id');
    expect(() => parseLwBlock('statements', '')).toThrow('Empty statements block');
    expect(() => parseLwBlock('statements', 'tag: [')).toThrow(/Invalid YAML/);
  });
});
