/**
 * A Vertex root the hub signs in to with its own Google identity stores no key: it reports a
 * credential (`has_credential`) with no masked hint. The dialog says so instead of asking for a
 * service-account file that would be ignored. Every other shape keeps the key field.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getChain: vi.fn(), onOpenChange: vi.fn() }));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    llmEndpointsService: {
      ...(actual.llmEndpointsService as object),
      getChain: h.getChain,
      getModelConfig: vi.fn(() =>
        Promise.resolve({ endpoint_typeid: 'x', tiers: {}, default_model: 'md', effective_default_model: 'm' }),
      ),
      listModels: vi.fn(() => Promise.resolve([])),
    },
  };
});
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

import { LLMEndpoint } from '@sdk';

import { LlmEndpointDialog } from '@src/components/llm-endpoints/LlmEndpointDialog';

const ID = '00000001-0000-4000-8000-000000000000';

function root(json: Record<string, unknown>): LLMEndpoint {
  const e = new LLMEndpoint({ id: ID, name: 'Hub Vertex', created_date: new Date(), ...json } as never);
  e.expand = { expansions: ['permissions'], allowed_actions: ['read', 'update', 'delete'] };
  return e;
}

function chain(hop: Record<string, unknown>) {
  return {
    entry: { id: ID, name: 'Hub Vertex' },
    hops: [{ id: ID, name: 'Hub Vertex', is_root: true, enabled: true, ...hop }],
    paths: [[ID]],
    missing_sources: [],
  };
}

function renderDialog(editing: LLMEndpoint) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LlmEndpointDialog open onOpenChange={h.onOpenChange} editing={editing} editingKind="root" all={[editing]} />
    </QueryClientProvider>,
  );
}

describe('LlmEndpointDialog: hub-identity Vertex root', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('explains that no key is needed when the root has a credential but no stored key', async () => {
    h.getChain.mockResolvedValue(chain({ provider: 'vertex', has_credential: true }));
    renderDialog(root({ provider: 'vertex', credential_hint: '' }));
    expect(await screen.findByTestId('hub-identity-note')).toBeTruthy();
    expect(screen.queryByPlaceholderText(/service_account/)).toBeNull();
  });

  it('keeps the key field when a key is stored', async () => {
    h.getChain.mockResolvedValue(chain({ provider: 'vertex', has_credential: true }));
    renderDialog(root({ provider: 'vertex', credential_hint: 'service account a@b.iam.gserviceaccount.com' }));
    await waitFor(() => expect(h.getChain).toHaveBeenCalled());
    expect(screen.queryByTestId('hub-identity-note')).toBeNull();
  });

  it('keeps the key field when the root has no credential at all', async () => {
    h.getChain.mockResolvedValue(chain({ provider: 'vertex', has_credential: false }));
    renderDialog(root({ provider: 'vertex', credential_hint: '' }));
    await waitFor(() => expect(h.getChain).toHaveBeenCalled());
    expect(screen.queryByTestId('hub-identity-note')).toBeNull();
  });

  it('does not say it for another provider', async () => {
    h.getChain.mockResolvedValue(chain({ provider: 'openrouter', has_credential: true }));
    renderDialog(root({ provider: 'openrouter', credential_hint: '' }));
    await waitFor(() => expect(h.getChain).toHaveBeenCalled());
    expect(screen.queryByTestId('hub-identity-note')).toBeNull();
  });
});
