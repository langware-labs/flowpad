/**
 * The agentic step, in the editor and in the run panel.
 *
 * A step can be a command, a question, or an AGENT — and the agent was the one
 * the editor refused ("change it in the file") and the debugger described as
 * "this step ran no commands". Both are the same gap: the kind of step whose
 * work is hardest to see was the one the UI said least about.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ openDock: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav, currentDock: null }),
}));

import { WizardStepForm } from '@src/components/assets/editor/wizard/WizardStepForm';
import { WizardStepInspector } from '@src/components/assets/editor/wizard/WizardStepInspector';
import { actionKindOf, setStepAction, type WizardStepDoc } from '@src/components/assets/editor/wizard/wizard-doc';

const STEP: WizardStepDoc = {
  id: 'install',
  label: 'Install it',
  process: { agent: 'capability-installer', prompt: 'install python3', output: 'version' },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderForm(step: WizardStepDoc, onSet = vi.fn(), agents = ['capability-installer', 'git-setup']) {
  render(
    <WizardStepForm
      step={step}
      index={0}
      agents={agents}
      expanded
      onToggle={vi.fn()}
      onSet={onSet}
      onRemove={vi.fn()}
      onSetAction={vi.fn()}
      onDelete={vi.fn()}
      readOnly={false}
      issuesAt={() => []}
    />,
  );
  return onSet;
}

describe('editing an agentic step', () => {
  it('edits the agent, the prompt and the returned name', () => {
    const onSet = renderForm(STEP);

    fireEvent.blur(screen.getByTestId('wizard-step-agent-install'), { target: { value: 'git-setup' } });
    expect(onSet).toHaveBeenCalledWith(['steps', 0, 'process', 'agent'], 'git-setup');

    fireEvent.blur(screen.getByTestId('wizard-step-prompt-install'), { target: { value: 'do it twice' } });
    expect(onSet).toHaveBeenCalledWith(['steps', 0, 'process', 'prompt'], 'do it twice');

    fireEvent.blur(screen.getByTestId('wizard-step-output-install'), { target: { value: 'release' } });
    expect(onSet).toHaveBeenCalledWith(['steps', 0, 'process', 'output'], 'release');
  });

  it('offers the installed agents without refusing an unknown one', () => {
    // A document written elsewhere may name an agent this machine lacks. A
    // Select would render that as empty and erase it on the next save; the
    // field keeps the name and says what will happen.
    renderForm({ ...STEP, process: { ...STEP.process, agent: 'not-installed' } });

    expect((screen.getByTestId('wizard-step-agent-install') as HTMLInputElement).value).toBe('not-installed');
    expect(screen.getByTestId('wizard-step-agent-install-unknown')).toBeTruthy();
  });

  it('says nothing about an agent it cannot check', () => {
    // An empty roster means the list has not loaded — not that every agent is
    // missing. Warning then would flag every step on a slow fetch.
    renderForm(STEP, vi.fn(), []);
    expect(screen.queryByTestId('wizard-step-agent-install-unknown')).toBeNull();
  });

  it('seeds a step switched to `process` so its fields render', () => {
    const doc = { steps: [{ id: 'a', command: { commands: { linux: 'true' } } }] };
    const next = setStepAction(doc, 0, 'process');

    expect(actionKindOf(next.steps![0])).toBe('process');
    expect(next.steps![0].process).toEqual({ agent: '', prompt: '' });
  });
});

describe('inspecting an agentic step', () => {
  it('shows the agent and prompt instead of "ran no commands"', () => {
    render(<WizardStepInspector step={STEP} outcome={null} />);

    expect(screen.getByTestId('wizard-process-step')).toBeTruthy();
    expect(screen.getByText('capability-installer')).toBeTruthy();
    expect(screen.queryByTestId('wizard-no-probes')).toBeNull();
  });

  it('shows what the agent RETURNED', () => {
    render(
      <WizardStepInspector
        step={STEP}
        outcome={{
          step_id: 'install',
          status: 'completed',
          message: 'installed Python 3.12.4',
          output: 'version',
          result: '3.12.4',
        }}
      />,
    );

    const returned = screen.getByTestId('wizard-process-result');
    expect(returned.textContent).toContain('3.12.4');
    expect(screen.getByText('installed Python 3.12.4')).toBeTruthy();
  });

  it('shows the live line while the agent is still working', () => {
    render(
      <WizardStepInspector
        step={STEP}
        outcome={null}
        live={{ state: 'running', current: 'working · src/foo.py' } as never}
      />,
    );

    expect(screen.getByTestId('wizard-process-live').textContent).toBe('working · src/foo.py');
  });

  it('leaves a command step probe list exactly as it was', () => {
    const command: WizardStepDoc = { id: 'c', command: { commands: { darwin: 'true' } } };
    render(
      <WizardStepInspector
        step={command}
        outcome={{
          step_id: 'c',
          status: 'completed',
          probes: [{ phase: 'action', command: 'true', returncode: 0 }],
        }}
      />,
    );

    expect(screen.getByTestId('wizard-probes')).toBeTruthy();
    expect(screen.queryByTestId('wizard-process-step')).toBeNull();
  });
});
