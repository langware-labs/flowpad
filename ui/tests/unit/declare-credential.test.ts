/**
 * `declareCredential` — what a credential's declaration is pointed AT.
 *
 * The rule this pins: the DEFINITION decides where its values live, and the
 * hook asks it. It used to hardcode `{kind:'env-local'}` for every spec, which
 * was right for Gmail and wrong for an LLM provider key — the funding resolver
 * (`agentic_process/cli_drivers/llm_source.py`) reads the encrypted store for a
 * secret named `lm_api.<provider>` and never consults `.env.local`, so an
 * OpenRouter key declared that way would be added, accepted, stored, and still
 * leave the LLM sources page saying no key is stored.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CredentialSpec } from '@sdk';

const h = vi.hoisted(() => ({
  addMany: vi.fn(async () => undefined),
  specs: [] as unknown[],
}));

vi.mock('@src/hooks/entity-hooks', () => ({ useEntitiesQuery: () => ({ data: h.specs }) }));
vi.mock('@src/hooks/use-project-secret-origins', () => ({
  useProjectSecretOrigins: () => ({
    secretOrigins: [],
    status: [],
    addMany: h.addMany,
    provide: vi.fn(),
  }),
}));
vi.mock('@src/hooks/use-project-env-local', () => ({
  useProjectEnvLocal: () => ({ keys: [], blocked: false }),
}));

import { useCredentialConnections } from '@src/components/connections-manager/use-credential-connections';

const spec = (over: Record<string, unknown>) =>
  new CredentialSpec({ id: '11111111-2222-4333-8444-555555555555', type: 'credential_spec', ...over } as never);

const OPENROUTER = spec({
  name: 'openrouter',
  title: 'OpenRouter',
  lm_provider: 'openrouter',
  default_store: 'sodot',
  vars: { OPENROUTER_API_KEY: { label: 'API key', sod_name: 'lm_api.openrouter' } },
});

const GMAIL = spec({
  name: 'gmail',
  title: 'Gmail',
  vars: { GMAIL_ADDRESS: { label: 'Gmail address' }, GMAIL_APP_PASSWORD: { label: 'App password' } },
});

const PROJECT = { id: 'p1', type: 'project' } as never;

describe('declareCredential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.specs = [];
  });

  it('points an LLM key at the encrypted store, under the name funding reads', async () => {
    const { result } = renderHook(() => useCredentialConnections(PROJECT));

    await result.current.declareCredential(OPENROUTER);

    await waitFor(() => expect(h.addMany).toHaveBeenCalledTimes(1));
    expect(h.addMany).toHaveBeenCalledWith([
      expect.objectContaining({
        envVar: 'OPENROUTER_API_KEY',
        locator: { kind: 'local', sod_name: 'lm_api.openrouter' },
        sodStore: 'sodot',
      }),
    ]);
  });

  it('still points an env-local credential at its .env.local key', async () => {
    const { result } = renderHook(() => useCredentialConnections(PROJECT));

    await result.current.declareCredential(GMAIL);

    // ONE call carrying both variables — a credential is a GROUP, and declaring
    // it one save at a time is what unlinked an earlier declaration.
    expect(h.addMany).toHaveBeenCalledTimes(1);
    expect(h.addMany).toHaveBeenCalledWith(
      ['GMAIL_ADDRESS', 'GMAIL_APP_PASSWORD'].map((envVar) =>
        expect.objectContaining({
          envVar,
          locator: { kind: 'env-local', env_key: envVar },
          sodStore: 'env-local',
        }),
      ),
    );
  });
});
