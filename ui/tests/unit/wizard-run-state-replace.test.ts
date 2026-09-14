/**
 * `run_state` must be REPLACED on an entity update, never merged.
 *
 * `DataManager.deepAssign` recurses into arrays and objects and merges by
 * key/index, never shrinking the target. A run record that gets SMALLER is
 * therefore corrupted by a refresh — and reset is exactly that: the backend
 * clears `inputs`, `awaiting` and `outcomes`, and merging `[]` over the old
 * arrays leaves every one of them in place. Only `status` (a scalar) cleared,
 * so the viewer went on showing the answers and step results of a run that no
 * longer existed. Caught in a browser, not by a test, which is why this exists.
 */
import { describe, expect, it } from 'vitest';
import { Wizard, type WizardRunState } from '@sdk';

const SETTLED: WizardRunState = {
  status: 'completed',
  inputs: { release: 'v1.0.0' },
  awaiting: [{ name: 'release' }],
  outcomes: [
    { step_id: 'a', status: 'completed' },
    { step_id: 'b', status: 'completed' },
  ],
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
    update(wizard, { run_state: { status: '', inputs: {}, awaiting: [], outcomes: [], approved: true } });

    expect(wizard.run_state?.inputs).toEqual({});
    expect(wizard.run_state?.outcomes).toEqual([]);
    expect(wizard.run_state?.awaiting).toEqual([]);
    // Approval survives a reset — it is a fact about trusting this wizard to
    // run shell here, not about one run's answers.
    expect(wizard.run_state?.approved).toBe(true);
  });

  it('strips the field from the payload so the following deepAssign skips it', () => {
    const wizard = fresh();
    // Assigning alone is not enough: deepAssign runs AFTER this hook on the
    // cached path and would merge the raw value straight back in.
    const payload = update(wizard, { name: 'renamed', run_state: { status: '', outcomes: [] } });

    expect('run_state' in payload).toBe(false);
    expect(payload.name).toBe('renamed');
  });

  it('leaves an update that does not carry run_state alone', () => {
    const wizard = fresh();
    update(wizard, { name: 'renamed' });

    expect(wizard.run_state?.outcomes).toHaveLength(2);
  });

  it('keeps a shorter outcome list short', () => {
    const wizard = fresh();
    update(wizard, { run_state: { status: 'completed', outcomes: [{ step_id: 'a', status: 'failed' }] } });

    // Index-wise merge would leave `b` stranded at index 1 behind the new `a`.
    expect(wizard.run_state?.outcomes).toHaveLength(1);
    expect(wizard.run_state?.outcomes?.[0]).toMatchObject({ step_id: 'a', status: 'failed' });
  });
});
