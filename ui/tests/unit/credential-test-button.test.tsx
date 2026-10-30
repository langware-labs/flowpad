import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { credentialsService } from '@sdk';
import { CredentialTestButton, CredentialTestDrawer, testWorkerPrompt } from '@src/components/credentials/CredentialTestButton';
import { oneVarDraft } from '@src/components/credentials/credential-draft';

// The worker chat is its own tested surface; here only that it opens on this credential, with the prompt.
vi.mock('@src/components/entity-execution-panel', () => ({
  EntityExecutionPanel: ({ target, autoPrompt }: { target: string; autoPrompt: { text: string } | null }) => (
    <div data-testid="worker-panel" data-target={target} data-prompt={autoPrompt?.text ?? ''} />
  ),
}));
vi.mock('@src/hooks/entity-hooks/useEntity', () => ({ useEntity: () => ({ data: null }) }));
vi.mock('@sdk/react/hooks', () => ({ useEntitiesQuery: () => ({ data: [{ asset_ref: '/skills/cred-scan' }] }) }));
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

const TYPEID = 'credential-550ff3e3-69a4-4595-adf0-248b3870795e';
const PROPS = { typeid: TYPEID, name: 'bright_data', title: 'Bright Data', projectId: 'p-1' };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CredentialTestButton — fast lane runs the test, slow lane asks a worker to write it', () => {
  it('runs the declared test here and refreshes', async () => {
    const test = vi.spyOn(credentialsService, 'test').mockResolvedValue({ has_test: true, state: 'ok', detail: '', at: '2026-10-31T00:00:00+00:00' });
    const onChanged = vi.fn();
    render(<CredentialTestButton {...PROPS} hasTest onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId('credential-test-bright_data'));
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(test).toHaveBeenCalledWith('bright_data', 'p-1');
    expect(screen.queryByTestId('worker-panel')).toBeNull();
  });

  it('with no test, opens the worker beside the credential, told to write one', () => {
    const test = vi.spyOn(credentialsService, 'test');
    render(
      <>
        <CredentialTestDrawer />
        <CredentialTestButton {...PROPS} hasTest={false} onChanged={vi.fn()} />
      </>,
    );

    fireEvent.click(screen.getByTestId('credential-test-bright_data'));
    const panel = screen.getByTestId('worker-panel');
    expect(panel.dataset.target).toBe(TYPEID);
    expect(panel.dataset.prompt).toBe(testWorkerPrompt('bright_data', 'Bright Data', 'p-1'));
    expect(panel.dataset.prompt).toContain('--project p-1');
    expect(panel.dataset.prompt).toContain('cred-scan test bright_data');
    expect(test).not.toHaveBeenCalled();
  });

  it('shows the last result on the button', () => {
    render(
      <CredentialTestButton {...PROPS} hasTest result={{ state: 'invalid', detail: 'HTTP 401', at: 'x' }} onChanged={vi.fn()} />,
    );
    expect(screen.getByTestId('credential-test-bright_data').dataset.testState).toBe('invalid');
  });
});

describe('oneVarDraft — the values form for one variable', () => {
  it('keeps only that variable', () => {
    const row = {
      typeid: TYPEID, name: 'twenty', title: 'Twenty', scope: 'project', value_store: 'env', state: 'connected',
      vars: [
        { env_var: 'TWENTY_URL', present: true, required: 'MUST' },
        { env_var: 'TWENTY_API_KEY', present: true, required: 'MUST' },
      ],
    } as never;
    const draft = oneVarDraft(row, 'TWENTY_API_KEY');
    expect(draft.mode).toBe('values');
    expect(draft.vars.map((v) => v.envVar)).toEqual(['TWENTY_API_KEY']);
  });
});
