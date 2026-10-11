/**
 * LLM sources: the two box-wide sections, `keys` and `endpoints`.
 *
 * Reached from the Assistants & keys modal's Details buttons by URL pointer, like a harness
 * is. The keys section is the key form that used to live in the modal; the endpoints section
 * lists what the account can spend and what is left on it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  status: vi.fn(),
  openPage: vi.fn(),
  getChain: vi.fn(),
  refresh: vi.fn(() => Promise.resolve(null)),
  subscribe: vi.fn(() => () => {}),
}));

vi.mock('@sdk/react/hooks/useLazyAsset', () => ({
  useLazyAsset: (asset: string) => ({
    data:
      asset === 'status'
        ? {
            harnesses: [],
            keys: [
              { provider: 'openrouter', stored: true, created_at: '', hint: '****ab12' },
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
  useDockNavigation: () => ({ navigation: { openPage: h.openPage }, currentDock: null }),
}));
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => false }));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    capabilityManager: { getSnapshot: () => ({ capability: null }), subscribe: h.subscribe },
    llmSourcesService: { chain: h.getChain, testSource: vi.fn(), select: vi.fn() },
    lmKeysService: { setLmApi: vi.fn(), testLmApi: vi.fn(), deleteLmApi: vi.fn() },
    statusService: { refresh: h.refresh },
  };
});

import { PageId, ViewType } from '@sdk';
import { LlmSourcesView } from '@src/components/llm-sources/LlmSourcesView';

const CLAUDE = 'harness.claude.cli';
const HUB_ID = '00000000-0000-4000-8000-00000000000b';
const HUB = `llm_endpoint-${HUB_ID}`;

function funding() {
  return {
    sources: { [CLAUDE]: [{ endpoint_typeid: HUB, name: 'eran default', rank: 20, eligible: true, auto: true }] },
    resolved: { [CLAUDE]: { endpoint_typeid: HUB, name: 'eran default' } },
    blocked: {},
    notes: {},
    endpoints: { [HUB]: { id: HUB_ID, kind: 'hub', provider: 'openrouter', name: 'eran default' } },
    available: [
      { id: HUB_ID, kind: 'hub', provider: 'openrouter', name: 'eran default' },
      { id: '00000000-0000-4000-8000-00000000000c', kind: 'hub', provider: 'openrouter', name: 'global' },
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

describe('LLM sources — the keys and endpoints sections', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.status.mockReturnValue(funding());
    h.getChain.mockResolvedValue({
      entry: { id: HUB_ID, name: 'x' },
      dim: '',
      hops: [
        {
          id: HUB_ID, name: 'x', provider: 'openrouter', is_root: true, has_credential: true, enabled: true,
          breaker: { state: 'closed', open_until: null }, limits: {}, effective_filters: {},
          remaining: { cost_usd_total: { limit: 3, used: 0.42, remaining: 2.58, window: 'total', resets_at: null } },
        },
      ],
    });
  });

  it('offers both sections as chips, and a chip is a navigation', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('llm-sources-chip-keys'));
    expect(h.openPage).toHaveBeenCalledWith(PageId.DESK, ViewType.LLM_SOURCES, 'keys');
    fireEvent.click(screen.getByTestId('llm-sources-chip-endpoints'));
    expect(h.openPage).toHaveBeenCalledWith(PageId.DESK, ViewType.LLM_SOURCES, 'endpoints');
    // Neither section is shown until its pointer says so; the harness list is.
    expect(screen.queryByTestId('llm-sources-keys')).toBeNull();
    expect(screen.queryByTestId('llm-sources-endpoints')).toBeNull();
    expect(screen.getByTestId('llm-sources-list')).toBeTruthy();
  });

  it('/keys shows the form and one slot per provider, with the masked hint of a stored key', async () => {
    renderPage('keys');
    await screen.findByTestId('llm-sources-keys');
    expect(screen.getByTestId('keys-input')).toBeTruthy();
    expect(screen.getByTestId('keys-row-openrouter').textContent).toContain('****ab12');
    expect(screen.getByTestId('keys-row-anthropic').textContent).toContain('not set');
    expect(screen.getByTestId('keys-test-openrouter')).toBeTruthy();
    expect(screen.queryByTestId('keys-test-anthropic')).toBeNull();
    // The harness list steps aside for a section.
    expect(screen.queryByTestId('llm-sources-list')).toBeNull();
  });

  it('/endpoints lists every hub endpoint, marks the one in use, and shows what is left on it', async () => {
    renderPage('endpoints');
    await screen.findByTestId('llm-sources-endpoints');
    const row = screen.getByTestId(`endpoint-row-${HUB_ID}`);
    expect(row.textContent).toContain('eran default');
    expect(row.textContent).toContain('in use');
    await waitFor(() => expect(screen.getByTestId(`endpoint-left-${HUB_ID}`).textContent).toContain('$3'));
    expect(h.getChain).toHaveBeenCalledWith(HUB_ID);
    expect(screen.getByTestId('endpoint-row-00000000-0000-4000-8000-00000000000c').textContent).toContain('global');
  });
});
