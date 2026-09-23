/**
 * One step, in the editor and in the run panel.
 *
 * A step is a single invocation — `kind` · `ref` · `args` — so the two surfaces
 * that used to branch three ways (a command grid, an agent panel, an input box)
 * now render one shape. What these guard is that the collapse did not take the
 * behaviour with it: switching kind must not leave a `ref` that means something
 * else, an unknown name must be kept rather than erased, and the inspector must
 * still say what a step DID when the run recorded nothing shell-shaped.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ openDock: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav, currentDock: null }),
}));
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntity: () => ({ data: null, isLoading: false, error: null }),
  useEntitiesQuery: () => ({ data: [], isLoading: false, error: null }),
}));

import { WizardStepForm } from '@src/components/assets/editor/wizard/WizardStepForm';
import { WizardStepInspector } from '@src/components/assets/editor/wizard/WizardStepInspector';
import { setStepKind, type WizardStepDoc } from '@src/components/assets/editor/wizard/wizard-doc';

const STEP: WizardStepDoc = {
  id: 'container',
  label: 'WAHA',
  kind: 'compute',
  ref: 'waha-container',
  args: { API_KEY: 'WAHA_API_KEY' },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderForm(
  step: WizardStepDoc,
  { onSet = vi.fn(), onRemove = vi.fn(), refOptions = [] as string[], scope = ['WAHA_API_KEY'] } = {},
) {
  render(
    <WizardStepForm
      step={step}
      index={0}
      expanded
      onToggle={vi.fn()}
      onSet={onSet}
      onRemove={onRemove}
      onSetKind={vi.fn()}
      onDelete={vi.fn()}
      readOnly={false}
      issuesAt={() => []}
      refOptions={refOptions}
      scope={scope}
    />,
  );
  return { onSet, onRemove };
}

describe('editing a step', () => {
  it('edits the ref and an argument by path', () => {
    const { onSet } = renderForm(STEP);

    fireEvent.blur(screen.getByTestId('wizard-step-ref-container'), {
      target: { value: 'waha-session' },
    });
    expect(onSet).toHaveBeenCalledWith(['steps', 0, 'ref'], 'waha-session');

    fireEvent.blur(screen.getByTestId('wizard-step-args-container-value-API_KEY'), {
      target: { value: 'literal-key' },
    });
    expect(onSet).toHaveBeenCalledWith(['steps', 0, 'args', 'API_KEY'], 'literal-key');
  });

  it('renames an argument key as an add plus a remove, so nothing is orphaned', () => {
    const { onSet, onRemove } = renderForm(STEP);

    fireEvent.blur(screen.getByTestId('wizard-step-args-container-key-API_KEY'), {
      target: { value: 'TOKEN' },
    });
    expect(onSet).toHaveBeenCalledWith(['steps', 0, 'args', 'TOKEN'], 'WAHA_API_KEY');
    expect(onRemove).toHaveBeenCalledWith(['steps', 0, 'args', 'API_KEY']);
  });

  it('offers the known refs without refusing an unknown one', () => {
    // A document written elsewhere may name a wizard this machine lacks. A
    // Select would render that as empty and erase it on the next save; the
    // field keeps the name and says what will happen.
    renderForm({ ...STEP, kind: 'wizard', ref: 'not-installed' }, { refOptions: ['waha-setup'] });

    expect((screen.getByTestId('wizard-step-ref-container') as HTMLInputElement).value).toBe(
      'not-installed',
    );
    expect(screen.getByTestId('wizard-step-ref-container-unknown')).toBeTruthy();
  });

  it('says nothing about a ref it cannot check', () => {
    // An empty roster means the list has not loaded — not that everything is
    // missing. Warning then would flag every step on a slow fetch. A `compute`
    // ref has no roster at all, which is the same answer.
    renderForm(STEP);
    expect(screen.queryByTestId('wizard-step-ref-container-unknown')).toBeNull();
  });

  it('warns when another step already uses this id', () => {
    render(
      <WizardStepForm
        step={STEP}
        index={1}
        expanded={false}
        onToggle={vi.fn()}
        onSet={vi.fn()}
        onRemove={vi.fn()}
        onSetKind={vi.fn()}
        onDelete={vi.fn()}
        readOnly={false}
        issuesAt={() => []}
        refOptions={[]}
        scope={[]}
        duplicateId
      />,
    );
    expect(screen.getByTestId('wizard-step-duplicate-container')).toBeTruthy();
  });

  it('clears the ref when the kind changes, because the string means something else', () => {
    const doc = { steps: [{ id: 'a', kind: 'compute' as const, ref: 'waha-container', args: {} }] };
    const next = setStepKind(doc, 0, 'wizard');

    expect(next.steps![0].kind).toBe('wizard');
    expect(next.steps![0].ref).toBe('');
  });
});

describe('inspecting a step', () => {
  it('says what the step invoked, with its arguments', () => {
    render(<WizardStepInspector step={STEP} outcome={null} />);

    expect(screen.getByText('waha-container')).toBeTruthy();
    expect(screen.getByTestId('wizard-step-args').textContent).toContain('API_KEY');
    // A step that ran no shell is no longer described as "ran no commands".
    expect(screen.getByTestId('wizard-step-not-run')).toBeTruthy();
  });

  it('shows what the step RETURNED', () => {
    render(
      <WizardStepInspector
        step={STEP}
        outcome={{
          step_id: 'container',
          exit_code: 0,
          detail: 'container is up',
          value: 'http://localhost:3000',
        }}
      />,
    );

    expect(screen.getByTestId('wizard-step-result').textContent).toContain('http://localhost:3000');
    expect(screen.getByText('container is up')).toBeTruthy();
  });

  it('shows the live line while the step is still working', () => {
    render(
      <WizardStepInspector
        step={STEP}
        outcome={null}
        live={{ state: 'running', current: 'working · src/foo.py' } as never}
      />,
    );

    expect(screen.getByTestId('wizard-step-live').textContent).toBe('working · src/foo.py');
  });

  it('lists the command the step ran and the check that judged it', () => {
    render(
      <WizardStepInspector
        step={STEP}
        outcome={{
          step_id: 'container',
          // As on the wire: a step's answer is Tagged, so it names its own class.
          spec_kind: 'compute.returned.cli',
          exit_code: 0,
          command: 'docker run waha',
          returncode: 0,
          stdout: 'started',
          check: { exit_code: 0, command: 'curl -sf localhost:3000', returncode: 0 },
        }}
      />,
    );

    expect(screen.getByTestId('wizard-probes')).toBeTruthy();
    expect(screen.getByTestId('wizard-probe-call').textContent).toContain('docker run waha');
    expect(screen.getByTestId('wizard-probe-check').textContent).toContain('curl -sf localhost:3000');
    expect(screen.getByText('started')).toBeTruthy();
  });

  it('shows no command rows for a step that ran none', () => {
    render(
      <WizardStepInspector
        step={STEP}
        outcome={{ step_id: 'container', exit_code: 0, text: 'the agent said so' }}
      />,
    );

    expect(screen.queryByTestId('wizard-probes')).toBeNull();
    expect(screen.getByText('the agent said so')).toBeTruthy();
  });

  it('shows what a nested wizard did, step by step', () => {
    render(
      <WizardStepInspector
        step={STEP}
        outcome={{
          step_id: 'container',
          spec_kind: 'compute.returned.wizard',
          exit_code: 1,
          steps: {
            fetch: { spec_kind: 'compute.returned.cli', exit_code: 0, ran: true },
            build: { spec_kind: 'compute.returned.cli', exit_code: 1, ran: true, detail: 'The command exited 2.' },
          },
        }}
      />,
    );

    const nested = screen.getByTestId('wizard-step-nested').textContent ?? '';
    expect(nested).toContain('fetch');
    expect(nested).toContain('build');
    expect(nested).toContain('The command exited 2.');
    // A nested wizard is not a process record: no command rows for it.
    expect(screen.queryByTestId('wizard-probes')).toBeNull();
  });
});
