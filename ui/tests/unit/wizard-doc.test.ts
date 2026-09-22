/**
 * The pure half of the wizard editor.
 *
 * These guard the two ways a form silently destroys a document it is editing:
 * dropping a key it does not render, and producing a step the backend refuses.
 * Both are invisible in the UI and only show up as "my wizard disappeared",
 * because the indexer's reader swallows a malformed document by design.
 */
import { describe, expect, it } from 'vitest';
import {
  blankStep,
  duplicateStepIds,
  issuesByLoc,
  namesInScope,
  orphanIssues,
  removeIn,
  setIn,
  setStepKind,
  shapeFromText,
  shapeToText,
  type WizardDoc,
} from '@src/components/assets/editor/wizard/wizard-doc';

/** Every optional key at once — the fixture exists to be a hostage. */
const FULL: WizardDoc = {
  name: 'full',
  description: 'has everything',
  enabled: true,
  version: 1,
  icon: 'Wand2',
  output: { url: 'string' },
  steps: [
    {
      id: 'one',
      label: 'One',
      description: 'the first',
      kind: 'compute',
      ref: 'waha-container',
      args: { API_KEY: 'WAHA_API_KEY', PORT: '3000' },
      on_fail: 'continue',
    },
    { id: 'two', kind: 'wizard', ref: 'region-setup' },
  ],
};

describe('setIn', () => {
  it('preserves every sibling key at every level', () => {
    const next = setIn(FULL, ['steps', 0, 'args', 'API_KEY'], 'REGION');

    const step = next.steps![0];
    expect(step.args!.API_KEY).toBe('REGION');
    // The sibling arg, the sibling fields, the sibling STEP, and every
    // top-level key. A shallow spread of the step drops all but the first.
    expect(step.args!.PORT).toBe('3000');
    expect(step.ref).toBe('waha-container');
    expect(step.on_fail).toBe('continue');
    expect(next.steps![1]).toEqual(FULL.steps![1]);
    expect(next.output).toEqual(FULL.output);
    expect(next.version).toBe(1);
  });

  it('does not mutate the document it was given', () => {
    const before = JSON.stringify(FULL);
    setIn(FULL, ['steps', 0, 'label'], 'changed');
    expect(JSON.stringify(FULL)).toBe(before);
  });

  it('creates missing intermediate objects', () => {
    const next = setIn({ steps: [{ id: 'a' }] } as WizardDoc, ['steps', 0, 'args', 'X'], 'y');
    expect(next.steps![0].args!.X).toBe('y');
  });
});

describe('removeIn', () => {
  it('deletes the key rather than writing undefined', () => {
    const next = removeIn(FULL, ['steps', 0, 'args', 'API_KEY']);
    const args = next.steps![0].args!;
    // `in`, not a truthiness check: an `undefined` VALUE would survive
    // JSON.stringify as a dropped key here but as `null` inside an array, and
    // `null` fails the backend's optional-field validation.
    expect('API_KEY' in args).toBe(false);
    expect(args.PORT).toBe('3000');
  });

  it('splices an array element out instead of leaving a hole', () => {
    const next = removeIn(FULL, ['steps', 0]);
    expect(next.steps).toHaveLength(1);
    expect(next.steps![0].id).toBe('two');
    expect(JSON.stringify(next.steps)).not.toContain('null');
  });
});

describe('setStepKind', () => {
  it('clears the ref it invalidates, because the same string means something else', () => {
    const step = setStepKind(FULL, 0, 'wizard').steps![0];
    expect(step.kind).toBe('wizard');
    expect(step.ref).toBe('');
    // The args belonged to the old callee.
    expect(step.args).toEqual({});
  });

  it('seeds an args map for the kinds that take one', () => {
    for (const kind of ['compute', 'wizard'] as const) {
      const step = setStepKind(FULL, 1, kind).steps![1];
      expect(step.kind).toBe(kind);
      expect(step.args).toEqual({});
    }
  });

  it('keeps the parts of the step that are not the invocation', () => {
    const step = setStepKind(FULL, 0, 'wizard').steps![0];
    expect(step.label).toBe('One');
    expect(step.description).toBe('the first');
    expect(step.on_fail).toBe('continue');
  });
});

describe('blankStep', () => {
  it('does not collide with an id already in the document', () => {
    const step = blankStep([{ id: 'step-1' }, { id: 'step-2' }, { id: 'x' }]);
    expect(['step-1', 'step-2', 'x']).not.toContain(step.id);
    expect(step.kind).toBe('compute');
  });
});

describe('duplicateStepIds', () => {
  it('names the ids two steps share, because their outcomes collide on it', () => {
    const twice = duplicateStepIds([{ id: 'a' }, { id: 'b' }, { id: 'a' }]);
    expect([...twice]).toEqual(['a']);
    expect(duplicateStepIds(FULL.steps).size).toBe(0);
  });
});

describe('namesInScope', () => {
  it('offers the steps BEFORE this one, never after', () => {
    expect(namesInScope(FULL, 0)).toEqual([]);
    expect(namesInScope(FULL, 1)).toEqual(['one']);
  });
});

describe('the authoring-form shape, as one line', () => {
  it('keeps "string" typeable as three plain words', () => {
    expect(shapeToText('string')).toBe('string');
    expect(shapeFromText('string')).toBe('string');
    expect(shapeFromText('  ')).toBeUndefined();
  });

  it('round-trips a structured shape through JSON', () => {
    expect(shapeFromText(shapeToText({ url: 'string' }))).toEqual({ url: 'string' });
    expect(shapeFromText('["string"]')).toEqual(['string']);
  });

  it('keeps unparseable text rather than losing what was typed', () => {
    // The backend is the validator; refusing to record the keystrokes would
    // throw them away with no error anywhere.
    expect(shapeFromText('{not json')).toBe('{not json');
  });
});

describe('issuesByLoc', () => {
  it('indexes by the joined loc so a field finds its own problems', () => {
    const map = issuesByLoc([
      { loc: ['steps', 0, 'args'], msg: 'no such parameter' },
      { loc: ['steps', 0, 'args'], msg: 'second problem, same field' },
      { loc: [], msg: 'about the document' },
    ]);
    expect(map.get('steps.0.args')).toHaveLength(2);
    expect(map.get('')).toHaveLength(1);
  });

  it('reports issues no field rendered, rather than dropping them', () => {
    const issues = [
      { loc: ['steps', 0, 'args'], msg: 'rendered' },
      { loc: ['steps', 9, 'ref'], msg: 'nothing draws this' },
    ];
    const orphans = orphanIssues(issues, new Set(['steps.0.args']));
    expect(orphans.map((i) => i.msg)).toEqual(['nothing draws this']);
  });
});
