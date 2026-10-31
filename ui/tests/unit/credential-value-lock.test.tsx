import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { credentialsService, dataContext, TypeId } from '@sdk';
import { CredentialValueLock } from '@src/components/conversation/CredentialValueLock';

let credential: object | null = null;
vi.mock('@sdk/react/hooks', () => ({ useEntity: () => ({ data: credential }) }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() } }),
}));
vi.mock('@src/components/credentials/use-credentials', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRefreshCredentials: () => async () => {},
}));
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

const TYPEID = new TypeId('credential', '550ff3e3-69a4-4595-adf0-248b3870795e');
const REF = { secret_ref: { vault: 'team', key: 'BRIGHT_DATA_API' } };

function stub({ sealed = [], vars = {}, present = false }: { sealed?: object[]; vars?: object; present?: boolean }) {
  credential = { name: 'bright_data', project_id: 'p-1', vars };
  vi.spyOn(dataContext, 'caps', 'get').mockReturnValue({ localFiles: true } as never);
  vi.spyOn(credentialsService, 'sealedIncoming').mockResolvedValue(sealed as never);
  const status = vi.spyOn(credentialsService, 'status').mockResolvedValue({
    credentials: [{ name: 'bright_data', vars: [{ env_var: 'BRIGHT_DATA_API', present }] }],
  } as never);
  vi.spyOn(credentialsService, 'vaults').mockResolvedValue({
    team: { manager: 'onepassword', config: { vault: 'GTM Studio' } },
  });
  vi.spyOn(credentialsService, 'listManagers').mockResolvedValue([
    { name: 'onepassword', title: '1Password' } as never,
  ]);
  return status;
}
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CredentialValueLock typeId={TYPEID} conversationId="c-1" />
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CredentialValueLock — a lock only when the value travelled too', () => {
  it('no sealed card and no vault ref: no lock (definition only)', async () => {
    stub({ vars: { BRIGHT_DATA_API: {} } });
    mount();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('credential-lock')).toBeNull();
  });

  it('a vault ref decides the route from the credential row — no project status read until opened', async () => {
    const status = stub({ vars: { BRIGHT_DATA_API: REF } });
    mount();
    expect((await screen.findByTestId('credential-lock')).dataset.route).toBe('vault');
    expect(status).not.toHaveBeenCalled();
  });

  it('secured transfer: short line, Fill in calls the sealed fill, details behind ⓘ', async () => {
    stub({
      sealed: [
        {
          message_id: 'm-1',
          transfer_id: 't-1',
          credential_name: 'bright_data',
          sender_name: 'Eran',
          state: 'pending',
          expires_at: '',
          variables: ['BRIGHT_DATA_API'],
        },
      ],
    });
    const fill = vi
      .spyOn(credentialsService, 'sealedFill')
      .mockResolvedValue({ filled: ['BRIGHT_DATA_API'], credential: 'bright_data' });
    mount();
    const lock = await screen.findByTestId('credential-lock');
    expect(lock.dataset.route).toBe('sealed');
    fireEvent.click(lock);
    expect(await screen.findByText('Eran sent you the key')).toBeTruthy();
    expect(screen.queryByTestId('credential-lock-detail-rows')).toBeNull();
    fireEvent.click(screen.getByTestId('credential-lock-details'));
    expect(screen.getByTestId('credential-lock-detail-rows').textContent).toContain('Names only, never values');
    fireEvent.click(screen.getByTestId('credential-lock-fill'));
    await vi.waitFor(() => expect(fill).toHaveBeenCalledWith('c-1', 'm-1'));
  });

  it('secret manager: names the manager; missing here → Fetch; denied → Request access', async () => {
    stub({ vars: { BRIGHT_DATA_API: REF } });
    vi.spyOn(credentialsService, 'fetch').mockResolvedValue({
      fetched: [],
      missing: [],
      denied: ['team'],
      vaults: ['team'],
    });
    mount();
    fireEvent.click(await screen.findByTestId('credential-lock'));
    expect(await screen.findByText('Key is in 1Password')).toBeTruthy();
    fireEvent.click(await screen.findByTestId('credential-lock-fetch'));
    expect(await screen.findByTestId('credential-lock-request')).toBeTruthy();
    expect(screen.getByText('You need access to the GTM Studio vault.')).toBeTruthy();
  });

  it('secret manager, value already here: Open credential', async () => {
    stub({ vars: { BRIGHT_DATA_API: REF }, present: true });
    mount();
    fireEvent.click(await screen.findByTestId('credential-lock'));
    expect(await screen.findByText('Ready on this machine.')).toBeTruthy();
    expect(screen.getByTestId('credential-lock-open')).toBeTruthy();
  });
});
