/**
 * `run_state` must be REPLACED on an entity update, never merged.
 *
 * `DataManager.deepAssign` recurses into arrays and objects and merges by
 * key/index, never shrinking the target. A run record that gets SMALLER is
 * therefore corrupted by a refresh — and reset is exactly that: the backend
 * clears `result`, and merging `null` over the old one leaves its steps in
 * place, so the viewer went on showing the step results of a run that no
 * longer existed. Caught in a browser, not by a test, which is why this exists.
 */
import { describe, expect, it } from 'vitest';
import { ExitCode, Wizard, type WizardRunState } from '@sdk';

const SETTLED: WizardRunState = {
  result: {
    exit_code: ExitCode.OK,
    steps: {
      a: { exit_code: ExitCode.OK },
      b: { exit_code: ExitCode.OK },
    },
  },
  approved: true,
};

/** A wizard holding a settled run — the state every case here starts from. */
const fresh = () => new Wizard({ id: '550e8400-e29b-41d4-a716-446655440000', run_state: SETTLED });

/** `onEntityUpdate` is the protected hook DataManager calls before deepAssign. */
function update(wizard: Wizard, data: Record<string, unknown>) {
  (wizard as unknown as { onEntityUpdate: (d: unknown) => void }).onEntityUpdate(data);
  return data;
}

describe('Wizard.onEntityUpdate', () => {
  it('clears a run record that shrank to nothing', () => {
    const wizard = fresh();
    update(wizard, { run_state: { result: null, approved: true } });

    expect(wizard.run_state?.result).toBeNull();
    // Approval survives a reset — it is a fact about trusting this wizard to
    // run shell here, not about one run.
    expect(wizard.run_state?.approved).toBe(true);
  });

  it('strips the field from the payload so the following deepAssign skips it', () => {
    const wizard = fresh();
    // Assigning alone is not enough: deepAssign runs AFTER this hook on the
    // cached path and would merge the raw value straight back in.
    const payload = update(wizard, { name: 'renamed', run_state: { result: null } });

    expect('run_state' in payload).toBe(false);
    expect(payload.name).toBe('renamed');
  });

  it('leaves an update that does not carry run_state alone', () => {
    const wizard = fresh();
    update(wizard, { name: 'renamed' });

    expect(Object.keys(wizard.run_state?.result?.steps ?? {})).toHaveLength(2);
  });

  it('keeps a smaller step map small', () => {
    const wizard = fresh();
    update(wizard, {
      run_state: { result: { exit_code: ExitCode.NOT_YET, steps: { a: { exit_code: ExitCode.NOT_YET } } } },
    });

    // A key-wise merge would leave `b` stranded beside the new `a`.
    expect(Object.keys(wizard.run_state?.result?.steps ?? {})).toEqual(['a']);
    expect(wizard.run_state?.result?.steps?.a).toMatchObject({ exit_code: ExitCode.NOT_YET });
  });
});
