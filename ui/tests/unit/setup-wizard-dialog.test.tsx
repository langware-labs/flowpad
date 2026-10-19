/**
 * A finished setup stage can be run again. "Done" is what its last run found, not a promise about now:
 * a WhatsApp phone that sent "stop" left the Flow source reading Connect ✓ with no way back to a code.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataSource } from '@sdk';

const { runFor } = vi.hoisted(() => ({ runFor: vi.fn(async () => ({ steps: {} })) }));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@src/components/ask/ask-claims', () => ({ claimAskRun: () => () => {} }));
vi.mock('@src/components/ask/AskForm', () => ({ AskForm: () => null }));
vi.mock('@sdk', async (orig) => {
  const sdk = await orig<typeof import('@sdk')>();
  const wizard = { name: 'flow-whatsapp-connect', runDetail: async () => ({ activity_path: '' }), runFor };
  return {
    ...sdk,
    apiClient: { get: async (path: string) => (path === '/graph/wizard' ? [{}] : { questions: [] }) },
    dataManager: { updateEntityFromJson: () => wizard },
  };
});

import { SetupWizardDialog } from '@src/components/setup-wizard/SetupWizardDialog';

afterEach(cleanup);

function sourceWith(state: 'done' | 'pending') {
  const source = new DataSource({ id: '0b1e8c3a-1d6f-4a52-9a77-5d1b2f3e4c5d', name: 'WhatsApp', provider: 'flow_whatsapp' });
  source.setupStages = async () =>
    [{ stage: 'connect', label: 'Connect', wizard: 'flow-whatsapp-connect', state, detail: '' }] as never;
  return source;
}

describe('SetupWizardDialog', () => {
  it('offers to run a done stage again, and runs its wizard for the source', async () => {
    render(<SetupWizardDialog source={sourceWith('done')} title="Flow" open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByTestId('setup-stage-rerun-connect'));
    await waitFor(() => expect(runFor).toHaveBeenCalledWith(expect.stringContaining('data_source-'), expect.anything()));
  });

  it('a pending stage offers Start, not Run again', async () => {
    render(<SetupWizardDialog source={sourceWith('pending')} title="Flow" open onOpenChange={() => {}} />);
    expect(await screen.findByTestId('setup-stage-run-connect')).toBeTruthy();
    expect(screen.queryByTestId('setup-stage-rerun-connect')).toBeNull();
  });
});
