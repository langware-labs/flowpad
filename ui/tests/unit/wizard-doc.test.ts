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
  actionKindOf,
  blankStep,
  issuesByLoc,
  orphanIssues,
  removeIn,
  setIn,
  setStepAction,
  type WizardDoc,
} from '@src/components/assets/editor/wizard/wizard-doc';

/** Every optional key at once — the fixture exists to be a hostage. */
const FULL: WizardDoc = {
  name: 'full',
  description: 'has everything',
  enabled: true,
  version: '2',
  triggers: [{ on: 'app.ready', fire_once: true }],
  steps: [
    {
      id: 'one',
      label: 'One',
      description: 'the first',
      precondition: { commands: { darwin: 'test -f a' }, satisfied_codes: [0, 2], timeout_seconds: 5 },
      command: { commands: { darwin: 'make a', linux: 'make a' }, timeout_seconds: 30 },
      verify: { commands: { darwin: 'test -f b' }, timeout_seconds: 7 },
      on_fail: 'continue',
    },
    { id: 'two', input: { name: 'token', shape: 'string', label: 'Token' } },
  ],
};

describe('setIn', () => {
  it('preserves every sibling key at every level', () => {
    const next = setIn(FULL, ['steps', 0, 'command', 'commands', 'darwin'], 'make it differently');

    const step = next.steps![0];
    expect(step.command!.commands!.darwin).toBe('make it differently');
    // The sibling platform, the sibling timeout, the sibling BLOCKS, and every
    // top-level key. A shallow spread of the step drops all but the first.
    expect(step.command!.commands!.linux).toBe('make a');
    expect(step.command!.timeout_seconds).toBe(30);
    expect(step.precondition).toEqual(FULL.steps![0].precondition);
    expect(step.verify).toEqual(FULL.steps![0].verify);
    expect(step.on_fail).toBe('continue');
    expect(next.steps![1]).toEqual(FULL.steps![1]);
    expect(next.triggers).toEqual(FULL.triggers);
    expect(next.version).toBe('2');
  });

  it('does not mutate the document it was given', () => {
    const before = JSON.stringify(FULL);
    setIn(FULL, ['steps', 0, 'label'], 'changed');
    expect(JSON.stringify(FULL)).toBe(before);
  });

  it('creates missing intermediate objects', () => {
    const next = setIn({ steps: [{ id: 'a' }] } as WizardDoc, ['steps', 0, 'verify', 'commands', 'linux'], 'true');
    expect(next.steps![0].verify!.commands!.linux).toBe('true');
  });
});

describe('removeIn', () => {
  it('deletes the key rather than writing undefined', () => {
    const next = removeIn(FULL, ['steps', 0, 'command', 'commands', 'darwin']);
    const commands = next.steps![0].command!.commands!;
    // `in`, not a truthiness check: an `undefined` VALUE would survive
    // JSON.stringify as a dropped key here but as `null` inside an array, and
    // `null` fails the backend's optional-field validation.
    expect('darwin' in commands).toBe(false);
    expect(commands.linux).toBe('make a');
  });

  it('splices an array element out instead of leaving a hole', () => {
    const next = removeIn(FULL, ['steps', 0]);
    expect(next.steps).toHaveLength(1);
    expect(next.steps![0].id).toBe('two');
    expect(JSON.stringify(next.steps)).not.toContain('null');
  });
});

describe('setStepAction', () => {
  it('never yields a step with zero or two actions', () => {
    for (const kind of ['command', 'process', 'input'] as const) {
      const next = setStepAction(FULL, 0, kind);
      const step = next.steps![0];
      const present = (['command', 'process', 'input'] as const).filter((k) => step[k] != null);
      expect(present).toEqual([kind]);
    }
  });

  it('keeps the parts of the step that are not the action', () => {
    const step = setStepAction(FULL, 0, 'input').steps![0];
    expect(step.precondition).toEqual(FULL.steps![0].precondition);
    expect(step.verify).toEqual(FULL.steps![0].verify);
    expect(step.label).toBe('One');
  });

  it('seeds the new action so the step is valid on arrival', () => {
    expect(setStepAction(FULL, 1, 'command').steps![1].command).toEqual({ commands: {} });
    expect(setStepAction(FULL, 0, 'input').steps![0].input).toEqual({ name: '', shape: 'string' });
  });
});

describe('actionKindOf', () => {
  it('names the action a step carries', () => {
    expect(actionKindOf(FULL.steps![0])).toBe('command');
    expect(actionKindOf(FULL.steps![1])).toBe('input');
    expect(actionKindOf({ id: 'broken' })).toBeUndefined();
  });
});

describe('blankStep', () => {
  it('does not collide with an id already in the document', () => {
    const step = blankStep([{ id: 'step-1' }, { id: 'step-2' }, { id: 'x' }]);
    expect(['step-1', 'step-2', 'x']).not.toContain(step.id);
    expect(actionKindOf(step)).toBe('command');
  });
});

describe('issuesByLoc', () => {
  it('indexes by the joined loc so a field finds its own problems', () => {
    const map = issuesByLoc([
      { loc: ['steps', 0, 'command', 'commands'], msg: 'no command for this platform' },
      { loc: ['steps', 0, 'command', 'commands'], msg: 'second problem, same field' },
      { loc: [], msg: 'about the document' },
    ]);
    expect(map.get('steps.0.command.commands')).toHaveLength(2);
    expect(map.get('')).toHaveLength(1);
  });

  it('reports issues no field rendered, rather than dropping them', () => {
    const issues = [
      { loc: ['steps', 0, 'command', 'commands'], msg: 'rendered' },
      { loc: ['steps', 9, 'process', 'agent'], msg: 'nothing draws this' },
    ];
    const orphans = orphanIssues(issues, new Set(['steps.0.command.commands']));
    expect(orphans.map((i) => i.msg)).toEqual(['nothing draws this']);
  });
});
