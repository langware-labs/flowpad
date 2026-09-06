/**
 * `FundingChip` — who is paying for the next agent run, in the footer.
 *
 * The assertions here are all about ONE rule: the chip renders the resolver's answer and
 * nothing it derived itself. That is the bug it exists to prevent — a box pinned to an
 * OpenRouter key while a Max subscription sat signed in and idle, with nothing on screen
 * saying so, because every surface re-derived "what funds this" from `Capability.auth_mode`
 * (the preference the user STATED) instead of from `resolved` (the verdict the resolver
 * REACHED). Those two disagree exactly when it matters.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LLMSourceAuthority, LLMSourceOrigin } from '@sdk';

import type { LLMEndpointOffer, LLMFundingStatus, LLMSource } from '@sdk';

const h = vi.hoisted(() => ({
  status: vi.fn<() => Promise<LLMFundingStatus | null>>(),
  select: vi.fn(),
  setReferenceKind: vi.fn(),
  loading: vi.fn(() => false),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    llmSourcesService: { status: h.status, select: h.select },
    capabilityManager: { setReferenceKind: h.setReferenceKind, load: vi.fn() },
  };
});

vi.mock('@src/components/llm-sources/use-llm-sources', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useLlmSources: () => ({ status: h.status(), isLoading: h.loading() }) };
});

vi.mock('@src/contexts/HarnessCapabilitiesContext', () => ({
  useDefaultWorkerType: () => 'claude_code',
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openPage: vi.fn() } }),
}));

import { FundingChip } from '@src/components/funding-chip/FundingChip';

const KIND = 'harness.claude.cli';
const DEVICE = 'llm_endpoint-device-1';
const KEY = 'llm_endpoint-key-1';
const HUB = 'llm_endpoint-hub-1';

function endpoint(id: string, kind: string, over: Partial<LLMEndpointOffer> = {}): LLMEndpointOffer {
  return {
    id,
    name: id,
    provider: kind === 'device' ? '' : 'openrouter',
    enabled: true,
    credential_hint: '',
    system_default: false,
    invoke_path: '',
    kind,
    secret_name: '',
    models: {},
    invocable: kind !== 'device',
    base_url: '',
    filters: {} as LLMEndpointOffer['filters'],
    limits: {} as LLMEndpointOffer['limits'],
    principal_typeid: null,
    ...over,
  };
}

function source(typeid: string, over: Partial<LLMSource> = {}): LLMSource {
  return {
    endpoint_typeid: typeid,
    name: typeid,
    detail: '',
    eligible: true,
    reason: '',
    auto: true,
    authority: LLMSourceAuthority.Cached,
    rank: 0,
    origin: LLMSourceOrigin.Default,
    ...over,
  };
}

function statusWith(resolvedTypeid: string | null, over: Partial<LLMFundingStatus> = {}): LLMFundingStatus {
  const resolved = resolvedTypeid ? source(resolvedTypeid, { origin: LLMSourceOrigin.User }) : null;
  return {
    available: [],
    endpoint_typeid: null,
    invoke_url: null,
    name: null,
    provider: null,
    hub_logged_in: true,
    hub_user_typeid: 'user-1',
    sources: {
      [KIND]: [
        source(DEVICE, { name: 'claude device login', rank: 0, detail: 'signed in' }),
        source(KEY, { name: 'openrouter key', rank: 10 }),
        source(HUB, { name: 'Team pool', rank: 20 }),
      ],
    },
    resolved: { [KIND]: resolved },
    blocked: { [KIND]: '' },
    endpoints: {
      [DEVICE]: endpoint(DEVICE, 'device'),
      [KEY]: endpoint(KEY, 'api_key'),
      [HUB]: endpoint(HUB, 'hub', { principal_typeid: 'user-1' }),
    },
    active_for: [],
    ...over,
  };
}

function renderChip() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FundingChip />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FundingChip', () => {
  it('names the harness AND the funding kind, from the resolver s answer', async () => {
    h.status.mockReturnValue(statusWith(KEY) as never);
    renderChip();
    await waitFor(() =>
      expect(screen.getByTestId('funding-chip-trigger').getAttribute('title')).toBe(
        'Claude · Funded by a stored API key',
      ),
    );
  });

  it('reads the kind off the RESOLVED endpoint, not off the highest-ranked offer', async () => {
    // The device login is rank 0 and `auto`, so anything deriving the answer from the offer
    // list would say "subscription". `resolved` says the key, and the key is what pays.
    h.status.mockReturnValue(statusWith(KEY) as never);
    renderChip();
    await waitFor(() =>
      expect(screen.getByTestId('funding-chip-trigger').getAttribute('title')).toContain(
        'stored API key',
      ),
    );
  });

  it('says nothing funds the harness, in the backend s own words', async () => {
    h.status.mockReturnValue(
      statusWith(null, { blocked: { [KIND]: 'claude is set to use a budget that no longer exists' } }) as never,
    );
    renderChip();
    await waitFor(() =>
      expect(screen.getByTestId('funding-chip-trigger').getAttribute('title')).toBe(
        'Claude · claude is set to use a budget that no longer exists',
      ),
    );
  });

  it('holds its place while the box has not answered yet, without claiming a kind', async () => {
    // The two nulls are different. A slow read must not make the chip pop in late and shove
    // the version chip sideways, but it must also not name a funding kind nobody has stated.
    h.loading.mockReturnValue(true);
    h.status.mockReturnValue(null as never);
    renderChip();
    await waitFor(() => expect(screen.getByTestId('funding-chip-pending')).toBeTruthy());
    expect(screen.queryByTestId('funding-chip-trigger')).toBeNull();
  });

  it('renders nothing at all where there is no box to ask', async () => {
    h.status.mockReturnValue(null as never);
    const { container } = renderChip();
    await waitFor(() => expect(container.querySelector('[data-testid="funding-chip-trigger"]')).toBeNull());
  });
});
