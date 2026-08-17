/**
 * `LlmEndpointsList` + the view's delete confirm: root and chain rows, their
 * badges, admin gating off the permission expansion, and delete going through
 * the generic entity DELETE only after the confirm.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openPage: vi.fn(),
  deleteEntity: vi.fn<(typeId: { type: string; id: string }) => Promise<void>>(() => Promise.resolve()),
  getUsage: vi.fn(() =>
    Promise.resolve({
      series: [],
      totals: {
        requests: 3,
        fallbacks: 0,
        errors: 0,
        input_tokens: 900,
        output_tokens: 600,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0.42,
        latency_ms_sum: 0,
        ttfb_ms_sum: 0,
        estimated_requests: 0,
        unpriced_requests: 0,
        total_tokens: 1500,
      },
    }),
  ),
  endpoints: [] as unknown[],
  refetch: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { ...(actual.dataManager as object), delete: h.deleteEntity },
    llmEndpointsService: { ...(actual.llmEndpointsService as object), getUsage: h.getUsage },
  };
});
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openPage: h.openPage }, currentDock: { page: 'hub' } }),
}));
vi.mock('@src/components/llm-endpoints/use-llm-endpoints', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLlmEndpoints: () => ({ endpoints: h.endpoints, isLoading: false, refetch: h.refetch, error: null }),
}));
vi.mock('@src/components/llm-endpoints/LlmEndpointDialog', () => ({ LlmEndpointDialog: () => null }));

import { LLMEndpoint, PageId, ViewType } from '@sdk';

import { LlmEndpointsView } from '@src/components/llm-endpoints/LlmEndpointsView';

// Fresh ids per test: the SDK registers every constructed entity by typeid, so
// reusing one across tests would trip its "already registered" guard.
let seq = 0;
const uuid = () => `${String(++seq).padStart(8, '0')}-0000-4000-8000-000000000000`;
let ROOT = uuid();
let CHAIN = uuid();

/** A hub-fetched entity: saved (created_date) with the permission expansion. */
function entity(json: Record<string, unknown>, allowed: string[]): LLMEndpoint {
  const e = new LLMEndpoint({ ...json, created_date: new Date() } as never);
  e.expand = { expansions: ['permissions'], allowed_actions: allowed };
  return e;
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LlmEndpointsView pointer={undefined} />
    </QueryClientProvider>,
  );
}

describe('LlmEndpointsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.endpoints.length = 0;
    ROOT = uuid();
    CHAIN = uuid();
  });
  afterEach(() => cleanup());

  it('renders a root and a chain row with kind/provider/credential badges and today usage', async () => {
    h.endpoints.push(
      entity(
        {
          id: ROOT,
          name: 'Anthropic prod',
          provider: 'anthropic',
          base_url: 'https://api.anthropic.com',
          credential_hint: '****abcd',
        },
        ['read', 'update', 'delete'],
      ),
      entity({ id: CHAIN, name: 'Team chain', sources: [`llm_endpoint-${ROOT}`], enabled: false }, ['read']),
    );
    renderView();

    const rootRow = screen.getByTestId(`llm-row-${ROOT}`);
    expect(within(rootRow).getByTestId('kind-badge-root')).toBeTruthy();
    expect(within(rootRow).getByTestId('provider-badge').textContent).toBe('anthropic');
    expect(within(rootRow).getByTestId('credential-chip').textContent).toContain('****abcd');
    expect(within(rootRow).getByTestId('enabled-dot-on')).toBeTruthy();

    const chainRow = screen.getByTestId(`llm-row-${CHAIN}`);
    expect(within(chainRow).getByTestId('kind-badge-chain')).toBeTruthy();
    expect(within(chainRow).queryByTestId('provider-badge')).toBeNull();
    expect(within(chainRow).getByTestId('enabled-dot-off')).toBeTruthy();
    // The chain row links to its source; the root row links back to its consumer.
    expect(within(chainRow).getByTestId(`llm-source-link-${ROOT}`).textContent).toBe('Anthropic prod');
    expect(within(rootRow).getByTestId(`llm-consumer-link-${CHAIN}`).textContent).toBe('Team chain');

    // Today's usage arrives per row from the usage action.
    expect(await within(rootRow).findByText('1.5K · $0.420')).toBeTruthy();
    expect(h.getUsage).toHaveBeenCalledWith(ROOT, expect.objectContaining({ granularity: 'hour' }));
  });

  it('gates edit/delete on the permission expansion', () => {
    h.endpoints.push(
      entity({ id: ROOT, name: 'admin one', provider: 'openai' }, ['read', 'update', 'delete']),
      entity({ id: CHAIN, name: 'reader one', sources: [`llm_endpoint-${ROOT}`] }, ['read']),
    );
    renderView();

    expect(screen.getByTestId(`llm-edit-${ROOT}`)).toBeTruthy();
    expect(screen.getByTestId(`llm-delete-${ROOT}`)).toBeTruthy();
    expect(screen.queryByTestId(`llm-edit-${CHAIN}`)).toBeNull();
    expect(screen.queryByTestId(`llm-delete-${CHAIN}`)).toBeNull();
    // Someone who administers an endpoint sees New endpoint.
    expect(screen.getByTestId('llm-new-endpoint')).toBeTruthy();
  });

  it('a pure reader can still create an endpoint of their own (creation is a type-level right)', () => {
    h.endpoints.push(entity({ id: CHAIN, name: 'reader one', sources: [`llm_endpoint-${ROOT}`] }, ['read']));
    renderView();
    expect(screen.getByTestId('llm-new-endpoint')).toBeTruthy();
  });

  it('opens a row on the hub page by pointer', async () => {
    h.endpoints.push(entity({ id: ROOT, name: 'r', provider: 'openai' }, ['read']));
    renderView();
    await userEvent.click(screen.getByText('r'));
    expect(h.openPage).toHaveBeenCalledWith(PageId.HUB, ViewType.LLM_ENDPOINTS, ROOT);
  });

  it('a source link in a chain row opens the SOURCE, not the row', async () => {
    h.endpoints.push(
      entity({ id: ROOT, name: 'root', provider: 'openai' }, ['read']),
      entity({ id: CHAIN, name: 'chain', sources: [`llm_endpoint-${ROOT}`] }, ['read']),
    );
    renderView();
    await userEvent.click(screen.getByTestId(`llm-source-link-${ROOT}`));
    expect(h.openPage).toHaveBeenCalledTimes(1);
    expect(h.openPage).toHaveBeenCalledWith(PageId.HUB, ViewType.LLM_ENDPOINTS, ROOT);
    h.openPage.mockClear();
    await userEvent.click(screen.getByTestId(`llm-consumer-link-${CHAIN}`));
    expect(h.openPage).toHaveBeenCalledTimes(1);
    expect(h.openPage).toHaveBeenCalledWith(PageId.HUB, ViewType.LLM_ENDPOINTS, CHAIN);
  });

  it('asks before deleting, then issues the generic entity DELETE', async () => {
    h.endpoints.push(entity({ id: ROOT, name: 'Doomed', provider: 'openai' }, ['read', 'update', 'delete']));
    renderView();

    await userEvent.click(screen.getByTestId(`llm-delete-${ROOT}`));
    expect(h.deleteEntity).not.toHaveBeenCalled();
    expect(screen.getByText(/will be removed/).textContent).toContain('Doomed');
    // Clicking the trash must not have opened the row.
    expect(h.openPage).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(h.deleteEntity).toHaveBeenCalledOnce();
    const typeId = h.deleteEntity.mock.calls[0][0];
    expect(typeId.type).toBe('llm_endpoint');
    expect(typeId.id).toBe(ROOT);
  });

  it('backs out of the confirm without deleting', async () => {
    h.endpoints.push(entity({ id: ROOT, name: 'Kept', provider: 'openai' }, ['read', 'update', 'delete']));
    renderView();
    await userEvent.click(screen.getByTestId(`llm-delete-${ROOT}`));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.deleteEntity).not.toHaveBeenCalled();
  });
});
