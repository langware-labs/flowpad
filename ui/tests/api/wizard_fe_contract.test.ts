/**
 * The mirror contract between the TypeScript `Wizard` types and the Python specs.
 *
 * There is no JSON-Schema-to-TypeScript codegen here, so the two halves of every
 * wizard shape are kept in step by this test and nothing else: a field added on
 * one side and not the other fails HERE rather than as a silently-undefined
 * value in somebody's debugger panel. No mocks — that is the point of the tier.
 *
 * **What it deliberately does not do.** It does not mint a wizard: a wizard is a
 * FOLDER asset, and a new folder is only discovered by an indexer walk, so a
 * freshly written one is invisible to the graph for reasons that have nothing to
 * do with the shapes under test. It also does not RUN one — the wizards
 * guaranteed to exist on any instance are the shipped ones, and running those on
 * a machine without python3 or git spawns a real installer agent. So probe
 * CONTENT is pinned on the Python side (`tests/unit/test_wizard_probes_and_reset.py`
 * asserts the serialized payload) and by `run-detail` here whenever the instance
 * happens to carry a recorded run; the assertions below are the ones that hold
 * on every instance.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  dataManager,
  QueryRequest,
  Wizard,
  type WizardRunDetail,
  type WizardStepOutcome,
  type WizardStepProbe,
  type WizardValidation,
} from '@sdk';
import { apiTestSetup } from '../utils/test-utils';

/** Every key each TypeScript interface declares. Literal, so a rename is caught. */
const VALIDATION_FIELDS: Array<keyof WizardValidation> = [
  'ok', 'issues', 'read_only', 'read_only_reason',
];
const DETAIL_FIELDS: Array<keyof WizardRunDetail> = [
  'status', 'message', 'inputs', 'awaiting', 'outcomes', 'archived',
];
const OUTCOME_FIELDS: Array<keyof WizardStepOutcome> = [
  'step_id', 'status', 'message', 'returncode', 'process_id', 'duration_s',
];
const PROBE_FIELDS: Array<keyof WizardStepProbe> = [
  'phase', 'command', 'returncode', 'timed_out', 'duration_s', 'stdout', 'stderr', 'truncated',
];

let wizards: Wizard[];

describe('wizard — frontend/backend shape contract', () => {
  beforeAll(async () => {
    await apiTestSetup();
    wizards = await dataManager.query<Wizard>(new QueryRequest({ type: Wizard.type, name: 'wizard fe contract' }));
    // Flowpad ships several, so an empty list means the graph is wrong, not that
    // this instance happens to have none.
    expect(wizards.length, 'no wizards on this instance — the shipped ones should be here').toBeGreaterThan(0);
  });

  it('carries the computed fields the viewer depends on', () => {
    for (const wizard of wizards) {
      // `activity_path` is how the viewer subscribes to a run's progress tree;
      // re-deriving the backend's slug convention in the frontend is how a
      // viewer ends up watching a tree nothing writes to.
      expect(wizard, 'activity_path missing').toHaveProperty('activity_path');
      expect(wizard.activity_path).toBeTruthy();
      // The only diagnostic for a document the reader silently dropped.
      expect(wizard, 'document_error missing').toHaveProperty('document_error');
      expect(wizard, 'shipped missing').toHaveProperty('shipped');
    }
  });

  it('never puts probes on `run_state`, which rides every row and every push', () => {
    for (const wizard of wizards) {
      for (const outcome of wizard.run_state?.outcomes ?? []) {
        expect(outcome, `probes leaked onto ${wizard.name}'s run_state`).not.toHaveProperty('probes');
      }
    }
  });

  it('round-trips every validation field', async () => {
    const verdict = await wizards[0].validateDocument();
    for (const field of VALIDATION_FIELDS) {
      expect(verdict, `WizardValidation.${String(field)} is missing from the wire`).toHaveProperty(field);
    }
  });

  it('answers 200 with a verdict for a document that cannot parse', async () => {
    // A driver must not 500 the button: a non-2xx would make the editor read its
    // error list out of a thrown exception, which is where error lists get lost.
    // Reaching this assertion at all is the proof — a 4xx/5xx would throw.
    const verdict = await wizards[0].validateDocument({ name: 'x', steps: [{ id: 'no-action' }] });

    expect(verdict.ok).toBe(false);
    expect(verdict.issues?.length).toBeGreaterThan(0);
    // `loc` addresses a field the form already renders — the reason validation
    // lives on the backend instead of being duplicated in the frontend.
    expect(verdict.issues?.[0].loc?.slice(0, 2)).toEqual(['steps', 0]);
    expect(verdict.issues?.[0].msg).toBeTruthy();
  });

  it('tells the frontend when a wizard may not be edited', async () => {
    const shipped = wizards.find((w) => w.shipped);
    expect(shipped, 'no shipped wizard found — Flowpad ships several').toBeTruthy();

    const verdict = await (shipped as Wizard).validateDocument();
    // The frontend's read-only answer comes from the backend, so one rule
    // decides it for both tiers.
    expect(verdict.read_only).toBe(true);
    expect(verdict.read_only_reason).toBeTruthy();
  });

  it('round-trips every run-detail field, and every probe field it carries', async () => {
    const detail = await wizards[0].runDetail();
    for (const field of DETAIL_FIELDS) {
      expect(detail, `WizardRunDetail.${String(field)} is missing`).toHaveProperty(field);
    }

    // Whatever runs this instance happens to hold get their shapes checked too.
    for (const outcome of detail.outcomes ?? []) {
      for (const field of OUTCOME_FIELDS) {
        expect(outcome, `WizardStepOutcome.${String(field)} is missing`).toHaveProperty(field);
      }
      for (const probe of outcome.probes ?? []) {
        for (const field of PROBE_FIELDS) {
          expect(probe, `WizardStepProbe.${String(field)} is missing`).toHaveProperty(field);
        }
        // The RESOLVED command for this platform, never the per-OS map.
        expect(typeof probe.command).toBe('string');
      }
    }
  });
});
