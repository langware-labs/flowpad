/**
 * Write-back edits to an `interface` block's YAML.
 *
 * The recurring assertion here is *preservation*: comments, key order, quoting
 * and blank lines must survive an edit, because the alternative (regenerating
 * from a parsed model) silently reformats the author's file the first time they
 * touch any field.
 */

import { applyInterfaceEdit } from '@src/components/milkdown-editor/plugins/fence-render/renderers/interface-edit';
import { parseInterfaceBlock } from '@src/components/milkdown-editor/plugins/fence-render/renderers/interface-schema';
import { describe, expect, it } from 'vitest';

const AUTHORED = `# The main entry point.
name: createTask
description: Create a task.

params:
  title: string      # required
  due: date?         # optional
returns: Task
errors: [NotFound, Forbidden]
`;

describe('applyInterfaceEdit preservation', () => {
  it('keeps comments, blank lines and key order when editing a scalar', () => {
    const next = applyInterfaceEdit(AUTHORED, { kind: 'name', value: 'makeTask' });

    expect(next).toContain('# The main entry point.');
    expect(next).toContain('# required');
    expect(next).toContain('# optional');
    expect(next).toContain('name: makeTask');
    expect(next).not.toContain('createTask');
    // Blank line between description and params survives.
    expect(next).toMatch(/description: Create a task\.\n\n/);
    // Key order unchanged.
    expect(next.indexOf('name:')).toBeLessThan(next.indexOf('description:'));
    expect(next.indexOf('params:')).toBeLessThan(next.indexOf('returns:'));
  });

  it('changes only the edited line', () => {
    // Comment padding is normalized (see below), so this fixture uses
    // single-space comments to isolate the "only one line moved" claim.
    const source = 'name: createTask\nparams:\n  title: string # required\nreturns: Task\n';
    const next = applyInterfaceEdit(source, { kind: 'returns', value: 'TaskId' });

    const before = source.split('\n');
    const differing = next.split('\n').filter((line, i) => line !== before[i]);
    expect(differing).toEqual(['returns: TaskId']);
  });

  /*
   * Documented limitation, asserted so it can't regress unnoticed: `yaml`'s
   * serializer doesn't record a comment's original column, so alignment padding
   * collapses to a single space. The comment text itself always survives.
   */
  it('collapses aligned-comment padding but keeps the comment', () => {
    const next = applyInterfaceEdit(AUTHORED, { kind: 'name', value: 'makeTask' });
    expect(next).toContain('title: string # required');
    expect(next).not.toContain('title: string      # required');
  });

  it('keeps the flow-sequence style of errors when editing one', () => {
    const next = applyInterfaceEdit(AUTHORED, { kind: 'error', index: 1, value: 'Denied' });
    expect(next).toContain('errors: [NotFound, Denied]');
  });
});

describe('applyInterfaceEdit param edits', () => {
  it('renames a param in place, keeping its position, value and comment', () => {
    const next = applyInterfaceEdit(AUTHORED, {
      kind: 'param-name',
      param: 'title',
      value: 'heading',
    });

    expect(next).toContain('heading: string');
    expect(next).toContain('# required');
    expect(parseInterfaceBlock(next).params.map((p) => p.name)).toEqual(['heading', 'due']);
  });

  it('edits a param type', () => {
    const next = applyInterfaceEdit(AUTHORED, { kind: 'param-type', param: 'title', value: 'text' });
    expect(parseInterfaceBlock(next).params[0]).toMatchObject({ name: 'title', type: 'text' });
  });

  /*
   * Optionality lives in the same scalar as the type (`date?`), so a naive type
   * edit would silently drop the `?` and quietly change the contract.
   */
  it('preserves the optional marker when the type is edited', () => {
    const next = applyInterfaceEdit(AUTHORED, {
      kind: 'param-type',
      param: 'due',
      value: 'timestamp',
    });
    expect(parseInterfaceBlock(next).params[1]).toMatchObject({
      name: 'due',
      type: 'timestamp',
      optional: true,
    });
    expect(next).toContain('due: timestamp?');
  });

  it('ignores a trailing ? typed into the type field rather than doubling it', () => {
    const next = applyInterfaceEdit(AUTHORED, {
      kind: 'param-type',
      param: 'due',
      value: 'timestamp?',
    });
    expect(next).toContain('due: timestamp?');
    expect(next).not.toContain('??');
  });

  it('toggles optional on', () => {
    const next = applyInterfaceEdit(AUTHORED, {
      kind: 'param-optional',
      param: 'title',
      optional: true,
    });
    expect(parseInterfaceBlock(next).params[0]).toMatchObject({ type: 'string', optional: true });
    expect(next).toContain('title: string?');
  });

  it('toggles optional off', () => {
    const next = applyInterfaceEdit(AUTHORED, {
      kind: 'param-optional',
      param: 'due',
      optional: false,
    });
    expect(parseInterfaceBlock(next).params[1]).toMatchObject({ type: 'date', optional: false });
    expect(next).toContain('due: date');
    expect(next).not.toContain('due: date?');
  });

  it('edits the object form of a param without flattening it', () => {
    const source = 'name: f\nparams:\n  title:\n    type: string\n    description: The title.\n';
    const next = applyInterfaceEdit(source, { kind: 'param-type', param: 'title', value: 'text' });

    expect(next).toContain('description: The title.');
    expect(parseInterfaceBlock(next).params[0]).toEqual({
      name: 'title',
      type: 'text',
      optional: false,
      description: 'The title.',
    });
  });

  it('edits an existing param description without changing its object shape', () => {
    const source = `name: f
params:
  title:
    type: string
    description: The title. # public docs
`;
    const next = applyInterfaceEdit(source, {
      kind: 'param-description',
      param: 'title',
      value: 'Display title.',
    });

    expect(next).toContain('description: Display title. # public docs');
    expect(parseInterfaceBlock(next).params[0].description).toBe('Display title.');
  });
});

describe('applyInterfaceEdit class member edits', () => {
  const CLASS_SOURCE = `name: Agent
properties:
  status:
    type: ProcessStatus?
    description: Current status. # reflected
methods:
  start:
    signature: "async (prompt?: string) -> ApiResponse"
    description: Start the worker.
`;

  it('renames and edits a property without losing optionality or comments', () => {
    const renamed = applyInterfaceEdit(CLASS_SOURCE, {
      kind: 'property-name',
      property: 'status',
      value: 'workerStatus',
    });
    const next = applyInterfaceEdit(renamed, {
      kind: 'property-type',
      property: 'workerStatus',
      value: 'WorkerStatus',
    });

    expect(next).toContain('# reflected');
    expect(parseInterfaceBlock(next).properties[0]).toMatchObject({
      name: 'workerStatus',
      type: 'WorkerStatus',
      optional: true,
    });
  });

  it('toggles a property optional marker through the same scalar convention as params', () => {
    const next = applyInterfaceEdit(CLASS_SOURCE, {
      kind: 'property-optional',
      property: 'status',
      optional: false,
    });
    expect(parseInterfaceBlock(next).properties[0]).toMatchObject({ optional: false });
    expect(next).toContain('type: ProcessStatus');
    expect(next).not.toContain('type: ProcessStatus?');
  });

  it('edits a described method signature without flattening its object', () => {
    const next = applyInterfaceEdit(CLASS_SOURCE, {
      kind: 'method-signature',
      method: 'start',
      value: 'async () -> boolean',
    });
    expect(next).toContain('description: Start the worker.');
    expect(parseInterfaceBlock(next).methods[0]).toEqual({
      name: 'start',
      signature: 'async () -> boolean',
      description: 'Start the worker.',
    });
  });

  it('edits property and method descriptions in place', () => {
    const property = applyInterfaceEdit(CLASS_SOURCE, {
      kind: 'property-description',
      property: 'status',
      value: 'Latest lifecycle state.',
    });
    const next = applyInterfaceEdit(property, {
      kind: 'method-description',
      method: 'start',
      value: 'Start or resume the worker.',
    });

    expect(next).toContain('description: Latest lifecycle state. # reflected');
    expect(parseInterfaceBlock(next).properties[0].description).toBe('Latest lifecycle state.');
    expect(parseInterfaceBlock(next).methods[0].description).toBe('Start or resume the worker.');
  });
});

describe('applyInterfaceEdit safety', () => {
  /*
   * The card can be one render behind the document. Doing nothing beats
   * corrupting the block.
   */
  it('returns the source unchanged for a param that no longer exists', () => {
    expect(applyInterfaceEdit(AUTHORED, { kind: 'param-name', param: 'ghost', value: 'x' })).toBe(AUTHORED);
    expect(applyInterfaceEdit(AUTHORED, { kind: 'param-type', param: 'ghost', value: 'x' })).toBe(AUTHORED);
  });

  it('returns the source unchanged for an out-of-range error index', () => {
    expect(applyInterfaceEdit(AUTHORED, { kind: 'error', index: 9, value: 'x' })).toBe(AUTHORED);
  });

  it('does not invent a key the author never wrote', () => {
    const source = 'name: ping\n';
    expect(applyInterfaceEdit(source, { kind: 'description', value: 'hi' })).toBe(source);
    expect(applyInterfaceEdit(source, { kind: 'returns', value: 'Pong' })).toBe(source);
    const compact = 'name: f\nparams:\n  title: string\n';
    expect(
      applyInterfaceEdit(compact, {
        kind: 'param-description',
        param: 'title',
        value: 'Title.',
      }),
    ).toBe(compact);
  });

  it('returns the source unchanged when the YAML does not parse', () => {
    const broken = 'name: [unclosed';
    expect(applyInterfaceEdit(broken, { kind: 'name', value: 'x' })).toBe(broken);
  });

  it('produces source that still round-trips through the parser', () => {
    const next = applyInterfaceEdit(AUTHORED, { kind: 'name', value: 'makeTask' });
    expect(parseInterfaceBlock(next)).toMatchObject({
      name: 'makeTask',
      returns: 'Task',
      errors: ['NotFound', 'Forbidden'],
    });
  });
});
