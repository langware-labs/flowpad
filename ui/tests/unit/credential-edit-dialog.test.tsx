/**
 * CredentialEditDialog — Keys is a plain list (name, Set / Not set, Update, Test where one applies);
 * Instructions renders the setup text.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { credentialsService, type CredentialStatusRow, type CredentialsStatus } from '@sdk';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/hooks/entity-hooks/useEntity', () => ({ useEntity: () => ({ data: null }) }));
vi.mock('@src/components/credentials/SignInCommand', () => ({
  SignInCommand: ({ command }: { command: string }) => <code>{command}</code>,
}));
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

import { CredentialEditDialog } from '@src/components/credentials/CredentialEditDialog';

const TYPEID = 'credential-2f82f22f-1d50-40fa-88b7-a17f437fe2c8';
const v = (env_var: string, over: Record<string, unknown> = {}) => ({
  env_var,
  kind: 'secret',
  present: false,
  required: 'MUST',
  secret: true,
  label: '',
  ...over,
});
const row = (over: Partial<CredentialStatusRow> = {}): CredentialStatusRow =>
  ({
    typeid: TYPEID,
    name: 'google-cloud',
    title: 'Google Cloud',
    description: '',
    icon_name: 'Cloud',
    help_url: '',
    setup: 'Run the **gcloud** sign-in.',
    scope: 'project',
    value_store: 'env',
    state: 'partial',
    vars: [
      v('GCLOUD_ADC', {
        kind: 'cli',
        present: true,
        required: 'ONE_OF',
        secret: false,
        login: 'gcloud auth application-default login',
      }),
      v('GOOGLE_CLOUD_PROJECT_ID', { required: 'OPTIONAL', secret: false }),
    ],
    ...over,
  }) as never;
const STATUS = { credentials: [], files: [], deployments: [], deployment_id: undefined } as unknown as CredentialsStatus;

const open = (r: CredentialStatusRow, onChanged = vi.fn()) =>
  render(<CredentialEditDialog row={r} status={STATUS} projectId="p-1" onClose={vi.fn()} onChanged={onChanged} />);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CredentialEditDialog', () => {
  it('lists each key with Set / Not set', () => {
    open(row());
    expect(screen.getByTestId('credential-key-state-GCLOUD_ADC').textContent).toBe('Set');
    expect(screen.getByTestId('credential-key-state-GOOGLE_CLOUD_PROJECT_ID').textContent).toBe('Not set');
  });

  it('Update then Set stores that one key and refreshes', async () => {
    const set = vi.spyOn(credentialsService, 'setValues').mockResolvedValue({} as never);
    const onChanged = vi.fn();
    open(row(), onChanged);
    fireEvent.click(screen.getByTestId('credential-key-update-GOOGLE_CLOUD_PROJECT_ID'));
    fireEvent.change(screen.getByTestId('credential-key-value-GOOGLE_CLOUD_PROJECT_ID'), {
      target: { value: 'spora-dev' },
    });
    fireEvent.click(screen.getByTestId('credential-key-set-GOOGLE_CLOUD_PROJECT_ID'));
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(set).toHaveBeenCalledWith(TYPEID, { GOOGLE_CLOUD_PROJECT_ID: 'spora-dev' }, undefined);
  });

  it('a cli key shows its sign-in command; Test only where one applies', () => {
    open(row());
    fireEvent.click(screen.getByTestId('credential-key-update-GCLOUD_ADC'));
    expect(screen.getByTestId('credential-key-field-GCLOUD_ADC').textContent).toContain('gcloud auth application-default login');
    expect(screen.getByTestId('credential-key-test-GCLOUD_ADC')).toBeTruthy();
    expect(screen.queryByTestId('credential-key-test-GOOGLE_CLOUD_PROJECT_ID')).toBeNull();
  });

  it('a declared test sits on the first required key, and its ok result reads Works', () => {
    open(row({ has_test: true, test_result: { state: 'ok', detail: '', at: 'x' } }));
    expect(screen.getByTestId('credential-edit-test-GCLOUD_ADC')).toBeTruthy();
    expect(screen.getByTestId('credential-key-state-GCLOUD_ADC').textContent).toBe('Works');
  });

  it('Instructions renders the setup text', () => {
    open(row());
    const tab = screen.getByTestId('credential-edit-tab-instructions');
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    expect(screen.getByTestId('credential-edit-instructions').querySelector('strong')?.textContent).toBe('gcloud');
  });
});
