import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Credential, credentialsService } from '@sdk';
import { SecretVaultPanel } from '@src/components/credentials-view/SecretVaultPanel';

// The ask-for-help dialog is its own tested surface; here only that it opens, and with what.
vi.mock('@src/components/help/AskForHelpDialog', () => ({
  AskForHelpDialog: ({ initialTitle, initialNotes }: { initialTitle: string; initialNotes: string }) => (
    <div data-testid="ask-for-help" data-title={initialTitle} data-notes={initialNotes} />
  ),
}));
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

const PROPS = {
  credentialId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
  name: 'bright_data',
  title: 'Bright Data',
  projectId: 'p-1',
  projectName: 'GTM Studio',
  refs: [{ env_var: 'BRIGHT_DATA_API', vault: 'team' }],
  onChanged: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SecretVaultPanel — values travel only through the project vaults', () => {
  it('lists the vaults and each variable’s vault, and fetches into this computer', async () => {
    const fetch = vi.spyOn(credentialsService, 'fetch').mockResolvedValue({
      fetched: ['BRIGHT_DATA_API'], missing: [], denied: [], vaults: ['team'],
    } as never);
    render(<SecretVaultPanel {...PROPS} vaults={['team']} missing />);

    expect(screen.getByTestId('credential-vault-refs').textContent).toContain('BRIGHT_DATA_API');
    fireEvent.click(screen.getByTestId('credential-vault-fetch'));
    await vi.waitFor(() => expect(PROPS.onChanged).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith('bright_data', 'p-1');
  });

  it('a denied vault offers Request access, sent as a share reply', async () => {
    vi.spyOn(credentialsService, 'fetch').mockResolvedValue({ fetched: [], missing: [], denied: ['team'], vaults: ['team'] } as never);
    const request = vi.spyOn(Credential.prototype, 'requestSecretAccess').mockResolvedValue();
    render(<SecretVaultPanel {...PROPS} vaults={['team']} missing />);

    fireEvent.click(screen.getByTestId('credential-vault-fetch'));
    await screen.findByTestId('credential-vault-denied');
    fireEvent.click(screen.getByTestId('credential-vault-request'));
    await screen.findByTestId('credential-vault-requested');
    expect(request).toHaveBeenCalledWith('team');
  });

  it('with no vault, says so and offers Report', () => {
    render(<SecretVaultPanel {...PROPS} vaults={[]} missing />);

    fireEvent.click(screen.getByTestId('credential-vault-report'));
    expect(screen.getByTestId('ask-for-help').dataset.title).toBe('GTM Studio has no secret manager');
  });

  it('with the values here, Publish goes to the variable’s vault; nothing missing and no vault shows nothing', async () => {
    const publish = vi.spyOn(credentialsService, 'publish').mockResolvedValue({ published: ['BRIGHT_DATA_API'] } as never);
    const view = render(<SecretVaultPanel {...PROPS} vaults={['team']} missing={false} />);
    fireEvent.click(screen.getByTestId('credential-vault-publish'));
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith('bright_data', 'p-1', 'team'));
    view.unmount();

    const empty = render(<SecretVaultPanel {...PROPS} vaults={[]} missing={false} />);
    expect(empty.container.innerHTML).toBe('');
  });
});
