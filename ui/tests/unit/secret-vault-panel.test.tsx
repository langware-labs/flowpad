import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { credentialsService } from '@sdk';
import { SecretStorePanel } from '@src/components/credentials-view/SecretStorePanel';

// The ask-for-help dialog is its own tested surface; here only that it opens, and with what.
vi.mock('@src/components/help/AskForHelpDialog', () => ({
  AskForHelpDialog: ({ initialTitle, initialNotes }: { initialTitle: string; initialNotes: string }) => (
    <div data-testid="ask-for-help" data-title={initialTitle} data-notes={initialNotes} />
  ),
}));
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

const PROPS = { name: 'bright_data', title: 'Bright Data', projectId: 'p-1', projectName: 'GTM Studio', onChanged: vi.fn() };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SecretStorePanel — values travel only through the project secret manager', () => {
  it('fetches into this computer when the project has a secret manager', async () => {
    const fetch = vi.spyOn(credentialsService, 'fetch').mockResolvedValue({
      fetched: ['BRIGHT_DATA_API'], missing: [], published: [], not_here: [], store: 'GCP gtm-studio/',
    });
    render(<SecretStorePanel {...PROPS} secretStore="GCP gtm-studio/" missing />);

    fireEvent.click(screen.getByTestId('credential-secret-store-fetch'));
    await vi.waitFor(() => expect(PROPS.onChanged).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith('bright_data', 'p-1');
  });

  it('a denied fetch offers Request access through ask-for-help', async () => {
    vi.spyOn(credentialsService, 'fetch').mockRejectedValue({
      response: { status: 400, data: { message: 'no access', data: { error_code: 'denied' } } },
    });
    render(<SecretStorePanel {...PROPS} secretStore="GCP gtm-studio/" missing />);

    fireEvent.click(screen.getByTestId('credential-secret-store-fetch'));
    await screen.findByTestId('credential-secret-store-denied');
    fireEvent.click(screen.getByTestId('credential-secret-store-request'));
    expect(screen.getByTestId('ask-for-help').dataset.title).toBe('Access to GTM Studio secrets');
  });

  it('with no secret manager, says so and offers Report', () => {
    render(<SecretStorePanel {...PROPS} secretStore={null} missing />);

    expect(screen.getByText('Receiving secrets requires a secret manager on the project.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('credential-secret-store-report'));
    expect(screen.getByTestId('ask-for-help').dataset.title).toBe('GTM Studio has no secret manager');
  });

  it('with the values here, offers Publish; with nothing missing and no store, shows nothing', () => {
    const view = render(<SecretStorePanel {...PROPS} secretStore="GCP gtm-studio/" missing={false} />);
    expect(screen.getByTestId('credential-secret-store-publish')).toBeTruthy();
    view.unmount();

    const empty = render(<SecretStorePanel {...PROPS} secretStore={null} missing={false} />);
    expect(empty.container.innerHTML).toBe('');
  });
});
