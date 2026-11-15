/**
 * LLM sources: three tabs — Logins, API keys, LLM Endpoints — over one table look.
 *
 * The two endpoint tabs embed the hub page's endpoints view: API keys lists this machine's key roots,
 * LLM Endpoints the hub's budgets; a local endpoint opens in the same detail, without the hub-only parts.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  status: vi.fn(),
  openPage: vi.fn(),
  openCredentials: vi.fn(),
  hubError: null as Error | null,
  refetchHub: vi.fn(),
  getChain: vi.fn(),
  refresh: vi.fn(() => Promise.resolve(null)),
  subscribe: vi.fn(() => () => {}),
  devices: vi.fn(),
  saveDevice: vi.fn(() => Promise.resolve({ ok: true })),
  keysStored: true,
}));

vi.mock('@sdk/react/hooks/useLazyAsset', () => ({
  useLazyAsset: (asset: string) => ({
    data:
      asset === 'status'
        ? {
            harnesses: [
              { kind: 'harness.claude.cli', worker_type: 'claude', label: 'Claude', login: 'signed_in', account: { identity: 'me@x.test', plan: '' } },
            ],
            keys: [
              { provider: 'openrouter', stored: h.keysStored, created_at: '', hint: '****ab12' },
              { provider: 'anthropic', stored: false, created_at: '', hint: '' },
              { provider: 'openai', stored: false, created_at: '', hint: '' },
            ],
            hub: { login: 'signed_in', user_typeid: 'user-1' },
          }
        : h.status(),
    isLoading: false,
  }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openPage: h.openPage, openCredentials: h.openCredentials }, currentDock: null }),
}));
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => false }));
vi.mock('@src/components/llm-endpoints/use-llm-endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/components/llm-endpoints/use-llm-endpoints')>();
  const { LLMEndpoint } = await import('@sdk');
  const hubRows = [new LLMEndpoint({ id: '00000000-0000-4000-8000-00000000000b', name: 'alice default' } as never)];
  return {
    ...actual,
    useLlmEndpoints: () => ({ endpoints: h.hubError ? [] : hubRows, isLoading: false, refetch: h.refetchHub, error: h.hubError }),
    useLlmEndpointModelConfig: () => ({ data: { default_model: null, effective_default_model: 'hub/resolved' }, error: null }),
    usageQueryOptions: (id: string) => ({ queryKey: ['usage', id], queryFn: () => new Promise(() => {}) }),
  };
});
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    capabilityManager: { getSnapshot: () => ({ capability: null }), subscribe: h.subscribe },
    llmSourcesService: { chain: h.getChain, testSource: vi.fn(), select: vi.fn() },
    lmKeysService: { setLmApi: vi.fn(), testLmApi: vi.fn(), deleteLmApi: vi.fn(), saveEndpoint: vi.fn(), listDeviceEndpoints: h.devices, saveDeviceEndpoint: h.saveDevice, listModels: vi.fn(async () => []) },
    dataContext: { caps: { localFiles: true } },
    statusService: { refresh: h.refresh },
  };
});

import { PageId, ViewType } from '@sdk';
import { LlmSourcesView } from '@src/components/llm-sources/LlmSourcesView';

const CLAUDE = 'harness.claude.cli';
const HUB_ID = '00000000-0000-4000-8000-00000000000b';
const HUB = `llm_endpoint-${HUB_ID}`;
const LOCAL_ID = '00000000-0000-4000-8000-00000000000d';
const DEVICE_ID = '00000000-0000-4000-8000-00000000000e';

function funding() {
  return {
    sources: { [CLAUDE]: [{ endpoint_typeid: HUB, name: 'alice default', rank: 20, eligible: true, auto: true }] },
    resolved: { [CLAUDE]: { endpoint_typeid: HUB, name: 'alice default' } },
    blocked: {},
    notes: {},
    endpoints: { [HUB]: { id: HUB_ID, kind: 'hub', provider: 'openrouter', name: 'alice default' } },
    available: [
      { id: HUB_ID, kind: 'hub', provider: 'openrouter', name: 'alice default' },
      {
        id: LOCAL_ID, kind: 'api_key', provider: 'openrouter', name: 'openrouter key', base_url: 'https://openrouter.ai/api',
        tiers: { sm: 'z-ai/glm-4.7-flash' }, limits: { cost_usd_total: 20 }, filters: {},
      },
    ],
    active_for: [],
  };
}

function renderPage(pointer?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<LlmSourcesView pointer={pointer} />, { wrapper });
}

describe('LLM sources — three tabs over one table', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.status.mockReturnValue(funding());
    h.keysStored = true;
    h.hubError = null;
    h.devices.mockResolvedValue([{ id: DEVICE_ID, name: 'Claude device login', harness: 'claude', kind: 'device', tiers: { sm: 'claude-small' }, invocable: false }]);
  });

  it('lands on Logins: each assistant with its login and what it runs on now', async () => {
    renderPage();
    const row = await screen.findByTestId('llm-login-row-claude');
    expect(row.textContent).toContain('Claude');
    expect(row.textContent).toContain('me@x.test');
    expect(screen.getByTestId('login-badge-signed_in')).toBeTruthy();
    expect(screen.getByTestId('llm-login-using-claude').textContent).toContain('alice default');
    fireEvent.click(row);
    expect(h.openPage).toHaveBeenCalledWith(PageId.DESK, ViewType.LLM_SOURCES, 'logins/claude');
  });

  it('shows the three tabs, each a navigation', async () => {
    renderPage();
    for (const tab of ['logins', 'keys', 'endpoints']) expect(await screen.findByTestId(`llm-sources-tab-${tab}`)).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId('llm-sources-tab-keys'));
    expect(h.openPage).toHaveBeenCalledWith(PageId.DESK, ViewType.LLM_SOURCES, 'keys');
  });

  it("an assistant's sources open under Logins — and the old bare-worker link still lands there", async () => {
    for (const pointer of ['logins/claude', 'claude']) {
      cleanup();
      renderPage(pointer);
      expect(await screen.findByTestId('llm-sources-list')).toBeTruthy();
      expect(screen.queryByTestId('llm-logins')).toBeNull();
    }
  });

  it('API keys lists only this machine, with its own columns', async () => {
    renderPage('keys');
    await screen.findByTestId('llm-endpoints-list');
    const local = screen.getByTestId(`llm-row-${LOCAL_ID}`);
    expect(local.textContent).toContain('****ab12');
    expect(local.querySelector('[data-testid="llm-row-limit-cost_usd_total"]')?.textContent).toContain('20');
    expect(screen.queryByTestId(`llm-row-${HUB_ID}`)).toBeNull();
    expect(screen.queryByTestId(`llm-row-${DEVICE_ID}`)).toBeNull();
    expect(screen.getByText('Stored limits (not enforced)')).toBeTruthy();
    expect(screen.getByTestId('llm-new-endpoint').textContent).toContain('Add API key');
    expect(screen.getByTestId(`llm-edit-${LOCAL_ID}`)).toBeTruthy();
    fireEvent.click(local);
    expect(h.openPage).toHaveBeenCalledWith(PageId.DESK, ViewType.LLM_SOURCES, `keys/${LOCAL_ID}`);
  });

  it('device logins do not fill the empty API-key tab or its count', async () => {
    h.keysStored = false;
    h.status.mockReturnValue({ ...funding(), available: [] });
    renderPage('keys');
    expect(await screen.findByText('No API keys on this machine yet.')).toBeTruthy();
    expect(screen.getByTestId('llm-sources-tab-keys').textContent).toBe('API keys');
    expect(screen.queryByTestId(`llm-row-${DEVICE_ID}`)).toBeNull();
  });

  it('edits login models from its existing worker detail and invalidates the device row', async () => {
    renderPage('logins/claude');
    fireEvent.click(await screen.findByTestId('device-model-settings'));
    const model = screen.getByTestId<HTMLInputElement>('tier-sm');
    expect(model.value).toBe('claude-small');
    fireEvent.change(model, { target: { value: 'claude-updated' } });
    fireEvent.click(screen.getByTestId('llm-submit'));
    await waitFor(() => expect(h.saveDevice).toHaveBeenCalledWith('claude', { tiers: { sm: 'claude-updated' } }));
    await waitFor(() => expect(h.devices.mock.calls.length).toBeGreaterThan(1));
  });

  it('LLM Endpoints lists only the hub', async () => {
    renderPage('endpoints');
    await screen.findByTestId('llm-endpoints-list');
    expect(screen.getByTestId(`llm-row-${HUB_ID}`)).toBeTruthy();
    expect(screen.queryByTestId(`llm-row-${LOCAL_ID}`)).toBeNull();
    expect(screen.getByTestId('llm-new-endpoint').textContent).toContain('New endpoint');
  });

  it('clears the last login model by saving an empty tier mapping', async () => {
    renderPage('logins/claude');
    fireEvent.click(await screen.findByTestId('device-model-settings'));
    fireEvent.change(screen.getByTestId('tier-sm'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('llm-submit'));
    await waitFor(() => expect(h.saveDevice).toHaveBeenCalledWith('claude', { tiers: {} }));
  });

  it('shows the authoritative hub error rather than an empty endpoint list', async () => {
    h.hubError = new Error('You are offline or signed out.');
    renderPage('endpoints');
    expect((await screen.findByRole('alert')).textContent).toContain('You are offline or signed out.');
    expect(screen.queryByText('No endpoints yet.')).toBeNull();
    expect(screen.queryByTestId('llm-new-endpoint')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.refetchHub).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    expect(h.openCredentials).toHaveBeenCalled();
  });

  it('a local endpoint opens in the shared detail without the hub-only parts', async () => {
    renderPage(`keys/${LOCAL_ID}`);
    await screen.findByTestId('llm-endpoint-detail');
    expect(screen.getByTestId('llm-local-credential').textContent).toContain('****ab12');
    expect(screen.queryByTestId('chain-tree')).toBeNull();
    expect(screen.queryByTestId('llm-tab-usage')).toBeNull();
    expect(screen.queryByTestId('members-avatar-stack')).toBeNull();
    expect(screen.getByTestId('model-size-sm').textContent).toContain('z-ai/glm-4.7-flash');
    expect(screen.getByTestId('llm-local-limits').textContent).toContain('20');
    expect(h.getChain).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('llm-detail-edit')).toBeTruthy());
  });
});
