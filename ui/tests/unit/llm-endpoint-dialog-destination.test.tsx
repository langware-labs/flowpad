/**
 * One "New endpoint" dialog for both places an endpoint can live.
 *
 * On a desktop runtime the dialog asks where: "This machine" stores a root's key locally
 * (`lmKeysService.saveEndpoint`), "On the hub" is the hub path (entity save + `setCredential`, or
 * `allocate` for a chain). This machine holds roots only, for the providers that `supportsLocal` —
 * so no funding-source choice and no Vertex. A hub-only runtime has no machine and is offered no
 * choice. An edit keeps the destination it was opened with.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  local: true,
  save: vi.fn(),
  setCredential: vi.fn(() => Promise.resolve({ ok: true, credential_hint: '****1234' })),
  saveEndpoint: vi.fn(() => Promise.resolve({ endpoint_id: 'local-1', valid: true })),
  saveDeviceEndpoint: vi.fn(() => Promise.resolve({ ok: true, endpoint_id: 'dev-1' })),
  invalidate: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { ...(actual.dataManager as object), save: h.save },
    llmEndpointsService: { ...(actual.llmEndpointsService as object), setCredential: h.setCredential },
    lmKeysService: {
      ...(actual.lmKeysService as object),
      saveEndpoint: h.saveEndpoint,
      saveDeviceEndpoint: h.saveDeviceEndpoint,
    },
  };
});
vi.mock('@src/components/llm-endpoints/local-endpoints', () => ({
  hasLocalEndpoints: () => h.local,
  invalidateLocalEndpoints: h.invalidate,
}));
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { LLMEndpoint } from '@sdk';

import { LlmEndpointDialog } from '@src/components/llm-endpoints/LlmEndpointDialog';
import { PROVIDERS } from '@src/components/llm-endpoints/endpoint-catalog';
import { providersFor } from '@src/components/llm-endpoints/endpoint-save';

function renderDialog(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('LlmEndpointDialog destination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.local = true;
    h.save.mockImplementation((typeId: { id: string }) => Promise.resolve({ id: typeId.id }));
  });
  afterEach(() => cleanup());

  it('the provider list is the catalog filtered by destination: no Vertex on this machine', () => {
    expect(providersFor(PROVIDERS, 'local').map((p) => p.id)).toEqual(['openrouter', 'anthropic', 'openai']);
    expect(providersFor(PROVIDERS, 'hub').map((p) => p.id)).toEqual(['openrouter', 'anthropic', 'openai', 'vertex']);
  });

  it('from the API keys tab: "This machine" is preselected, roots only, saved to the local store', async () => {
    renderDialog(<LlmEndpointDialog open onOpenChange={vi.fn()} all={[]} destination="local" />);

    expect(screen.getByRole('heading', { name: 'New endpoint' })).toBeTruthy();
    expect(screen.getByTestId('destination-local').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('kind-chain')).toBeNull(); // funding source is a hub choice
    expect(screen.queryByTestId('provider-vertex')).toBeNull();

    await userEvent.type(screen.getByTestId('llm-name'), 'My Anthropic');
    await userEvent.click(screen.getByTestId('provider-anthropic'));
    await userEvent.type(screen.getByTestId('credential-input'), 'sk-ant-secret-0123456789abcdef');
    await userEvent.click(screen.getByTestId('llm-submit'));

    await waitFor(() => expect(h.saveEndpoint).toHaveBeenCalledOnce());
    const [provider, body] = h.saveEndpoint.mock.calls[0] as unknown as [string, { key: string }];
    expect(provider).toBe('anthropic');
    expect(body.key).toBe('sk-ant-secret-0123456789abcdef');
    expect(h.save).not.toHaveBeenCalled();
    expect(h.setCredential).not.toHaveBeenCalled();
  });

  it('switching to "On the hub" offers the funding source and Vertex, and saves through the hub', async () => {
    renderDialog(<LlmEndpointDialog open onOpenChange={vi.fn()} all={[]} destination="local" />);

    await userEvent.click(screen.getByTestId('destination-hub'));
    expect(screen.getByTestId('kind-chain')).toBeTruthy();
    expect(screen.getByTestId('provider-vertex')).toBeTruthy();

    await userEvent.type(screen.getByTestId('llm-name'), 'Team key');
    await userEvent.click(screen.getByTestId('llm-submit'));

    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(h.saveEndpoint).not.toHaveBeenCalled();
  });

  it('a Vertex draft switched to "This machine" moves to a provider the machine supports', async () => {
    renderDialog(<LlmEndpointDialog open onOpenChange={vi.fn()} all={[]} />);
    await userEvent.click(screen.getByTestId('provider-vertex'));
    await userEvent.click(screen.getByTestId('destination-local'));
    // Vertex is not offered here, so the draft moved to the first provider that is.
    expect(screen.getByTestId('provider-openrouter').className).toContain('border-primary');
    expect(screen.getByTestId<HTMLInputElement>('llm-base-url').value).toBe('https://openrouter.ai/api');
  });

  it('a hub-only runtime shows no destination choice and saves to the hub', async () => {
    h.local = false;
    renderDialog(<LlmEndpointDialog open onOpenChange={vi.fn()} all={[]} destination="local" />);

    expect(screen.queryByTestId('llm-destination')).toBeNull();
    expect(screen.getByTestId('kind-chain')).toBeTruthy();
    await userEvent.type(screen.getByTestId('llm-name'), 'Hub root');
    await userEvent.click(screen.getByTestId('llm-submit'));
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(h.saveEndpoint).not.toHaveBeenCalled();
  });

  it('an edit keeps its destination: no choice, title "Edit endpoint", local save', async () => {
    const editing = new LLMEndpoint({ id: 'local-1', name: 'Mine', provider: 'anthropic' } as never);
    renderDialog(<LlmEndpointDialog open onOpenChange={vi.fn()} all={[]} editing={editing} destination="local" />);

    expect(screen.getByRole('heading', { name: 'Edit endpoint' })).toBeTruthy();
    expect(screen.queryByTestId('llm-destination')).toBeNull();
    await userEvent.click(screen.getByTestId('llm-submit'));
    await waitFor(() => expect(h.saveEndpoint).toHaveBeenCalledOnce());
    expect(h.save).not.toHaveBeenCalled();
  });

  it('a device login is edited in the same dialog: read-only name, typed sizes and custom names only', async () => {
    const device = {
      id: 'dev-1',
      name: 'codex device login',
      kind: 'device' as const,
      harness: 'codex',
      tiers: { sm: 'gpt-small', coding: 'gpt-coder' },
      invocable: false as const,
    };
    const editing = new LLMEndpoint({ id: device.id, name: device.name, provider: '', tiers: device.tiers } as never);
    renderDialog(
      <LlmEndpointDialog open onOpenChange={vi.fn()} all={[]} destination="local" editing={editing} device={device} />,
    );

    expect(screen.getByRole('heading', { name: 'Edit device login' })).toBeTruthy();
    expect((screen.getByTestId('llm-name')).disabled).toBe(true);
    for (const gone of [
      'llm-destination',
      'kind-root',
      'provider-openrouter',
      'llm-base-url',
      'credential-input',
      'toggle-advanced',
    ]) {
      expect(screen.queryByTestId(gone)).toBeNull();
    }
    expect((screen.getByTestId('tier-sm')).value).toBe('gpt-small');
    expect(screen.getByTestId('device-custom-models')).toBeTruthy();

    await userEvent.type(screen.getByTestId('tier-lg'), 'gpt-large');
    await userEvent.click(screen.getByTestId('llm-submit'));

    await waitFor(() => expect(h.saveDeviceEndpoint).toHaveBeenCalledOnce());
    expect(h.saveDeviceEndpoint).toHaveBeenCalledWith('codex', {
      tiers: { sm: 'gpt-small', lg: 'gpt-large', coding: 'gpt-coder' },
    });
    expect(h.saveEndpoint).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
});
