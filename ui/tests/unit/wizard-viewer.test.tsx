/**
 * `WizardViewer` — the two behaviours a person actually depends on.
 *
 * 1. The approval gate is rendered IN THE PAGE, never `window.confirm`. A native
 *    modal blocks the whole renderer (nothing else paints, and any automation
 *    driving the app deadlocks on it) and cannot show what is about to run,
 *    which is the entire point of the gate. This test asserts `window.confirm`
 *    is never called — that is the regression, not the wording.
 * 2. A parked run renders its form FROM `awaiting[]`, so a wizard that declares
 *    a new input grows a field with no change to this component.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ callAction: vi.fn(), refreshByTypeId: vi.fn() }));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { callAction: h.callAction, refreshByTypeId: h.refreshByTypeId },
  };
});
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

import { WizardViewer } from '@src/components/assets/editor/wizard/WizardViewer';

const wizard = (runState: Record<string, unknown>, shipped = false) =>
  ({
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'UI probe',
    description: 'Asks for a name.',
    shipped,
    run_state: runState,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.callAction.mockResolvedValue({ status: 'pending' });
  h.refreshByTypeId.mockResolvedValue(null);
});
afterEach(cleanup);

describe('WizardViewer', () => {
  it('asks for approval in the page — never through window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<WizardViewer wizard={wizard({})} />);

    fireEvent.click(screen.getByTestId('wizard-run'));

    await screen.findByTestId('wizard-approval');
    expect(confirmSpy).not.toHaveBeenCalled();
    // Merely opening the panel must not have run anything yet.
    expect(h.callAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('wizard-approve'));
    await waitFor(() => expect(h.callAction).toHaveBeenCalledTimes(1));
    expect(h.callAction.mock.calls[0][0].bodyParameters).toEqual({ approved: true });
  });

  it('runs a shipped wizard with no approval panel at all', async () => {
    render(<WizardViewer wizard={wizard({}, true)} />);
    fireEvent.click(screen.getByTestId('wizard-run'));
    await waitFor(() => expect(h.callAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('wizard-approval')).toBeNull();
    expect(h.callAction.mock.calls[0][0].bodyParameters).toEqual({});
  });

  it('renders the form from awaiting[] and submits the value by name', async () => {
    render(
      <WizardViewer
        wizard={wizard({
          status: 'pending',
          awaiting: [{ name: 'marker', label: 'Marker file name', description: 'Under /tmp' }],
          outcomes: [{ step_id: 'ask', status: 'awaiting_input', message: 'needs marker' }],
        })}
      />,
    );

    expect(screen.getByText('Marker file name')).toBeTruthy();
    fireEvent.change(screen.getByTestId('wizard-input-marker'), {
      target: { value: 'proof.txt' },
    });
    fireEvent.click(screen.getByTestId('wizard-submit-marker'));

    await waitFor(() => expect(h.callAction).toHaveBeenCalledTimes(1));
    const info = h.callAction.mock.calls[0][0];
    expect(info.name ?? info.actionName).toBe('set-input');
    expect(info.bodyParameters).toEqual({ name: 'marker', value: 'proof.txt' });
  });
});
