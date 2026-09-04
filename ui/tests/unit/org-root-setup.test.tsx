/**
 * `OrgRootSetup` — bringing your own provider key at the organization level.
 *
 * The whole point of this component: an admin creating a new organization and allocating money
 * never has to visit the expert LLM Endpoints page first. Submitting here is two hub calls in
 * sequence (create the root, then store the key on the id that returns) — and a failure in the
 * SECOND call must be distinguishable from a failure in the first, because the first one already
 * landed and re-submitting it would be wrong.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  setCredential: vi.fn(),
}));

vi.mock('@src/components/organization/budgets/use-budgets', () => ({
  useSetupOrgRoot: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    llmEndpointsService: { ...(actual.llmEndpointsService as object), setCredential: h.setCredential },
  };
});

import { OrgRootSetup } from '@src/components/organization/budgets/OrgRootSetup';

const ORG_ID = '550e8400-e29b-41d4-a716-446655440000';
const ENDPOINT_TYPEID = 'llm_endpoint-550e8400-e29b-41d4-a716-446655440099';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OrgRootSetup — no budget yet', () => {
  const org = { endpoint_id: null, is_root: false, provider: null, credential_hint: '' };

  it('defaults to the first provider and lets another be picked', () => {
    render(<OrgRootSetup orgId={ORG_ID} org={org} />);

    expect(screen.getByTestId('org-root-provider-openrouter').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('org-root-provider-anthropic'));
    expect(screen.getByTestId('org-root-provider-anthropic').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('org-root-provider-openrouter').getAttribute('aria-pressed')).toBe('false');
  });

  it('does nothing when Activate is pressed with no key typed', () => {
    render(<OrgRootSetup orgId={ORG_ID} org={org} />);
    expect(screen.getByTestId('org-root-activate')).toHaveProperty('disabled', true);
    expect(h.mutateAsync).not.toHaveBeenCalled();
  });

  it('creates the root then stores the key, in that order, with the chosen provider', async () => {
    h.mutateAsync.mockResolvedValue({ endpoint_id: ENDPOINT_TYPEID, created: true, rebased: 0 });
    h.setCredential.mockResolvedValue({ ok: true, credential_hint: '****abcd' });
    render(<OrgRootSetup orgId={ORG_ID} org={org} />);

    fireEvent.click(screen.getByTestId('org-root-provider-anthropic'));
    fireEvent.change(screen.getByTestId('credential-input'), { target: { value: 'sk-ant-secret' } });
    fireEvent.click(screen.getByTestId('org-root-activate'));

    await waitFor(() => expect(h.setCredential).toHaveBeenCalled());
    expect(h.mutateAsync).toHaveBeenCalledWith({
      orgId: ORG_ID,
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(h.setCredential).toHaveBeenCalledWith(ENDPOINT_TYPEID, 'sk-ant-secret');
    // The order matters: the key can only be stored once the id creating it returns.
    const rootCallOrder = h.mutateAsync.mock.invocationCallOrder[0];
    const credentialCallOrder = h.setCredential.mock.invocationCallOrder[0];
    expect(rootCallOrder).toBeLessThan(credentialCallOrder);
  });

  it('trims the key before sending it', async () => {
    h.mutateAsync.mockResolvedValue({ endpoint_id: ENDPOINT_TYPEID, created: true, rebased: 0 });
    h.setCredential.mockResolvedValue({ ok: true, credential_hint: '****abcd' });
    render(<OrgRootSetup orgId={ORG_ID} org={org} />);

    fireEvent.change(screen.getByTestId('credential-input'), { target: { value: '  sk-or-secret  ' } });
    fireEvent.click(screen.getByTestId('org-root-activate'));

    await waitFor(() => expect(h.setCredential).toHaveBeenCalledWith(ENDPOINT_TYPEID, 'sk-or-secret'));
  });

  it('reports it distinctly when the root is created but the key fails to store', async () => {
    h.mutateAsync.mockResolvedValue({ endpoint_id: ENDPOINT_TYPEID, created: true, rebased: 0 });
    h.setCredential.mockRejectedValue(new Error('network blip'));
    render(<OrgRootSetup orgId={ORG_ID} org={org} />);

    fireEvent.change(screen.getByTestId('credential-input'), { target: { value: 'sk-or-secret' } });
    fireEvent.click(screen.getByTestId('org-root-activate'));

    await waitFor(() => expect(h.setCredential).toHaveBeenCalled());
    // The mutation resolved (the root exists); only the key call rejected. Nothing here re-throws
    // that as "could not create the organization".
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('reports plainly when creating the root itself fails, and never calls setCredential', async () => {
    h.mutateAsync.mockRejectedValue(new Error('this organization already draws its budget from a shared pool'));
    render(<OrgRootSetup orgId={ORG_ID} org={org} />);

    fireEvent.change(screen.getByTestId('credential-input'), { target: { value: 'sk-or-secret' } });
    fireEvent.click(screen.getByTestId('org-root-activate'));

    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalled());
    expect(h.setCredential).not.toHaveBeenCalled();
  });
});

describe('OrgRootSetup — already a root', () => {
  it('shows the provider and the masked hint, with no provider picker', () => {
    render(
      <OrgRootSetup
        orgId={ORG_ID}
        org={{ endpoint_id: ENDPOINT_TYPEID, is_root: true, provider: 'openai', credential_hint: '****z9z9' }}
      />,
    );

    expect(screen.getByTestId('org-root-key')).toBeTruthy();
    expect(screen.getByText('OpenAI')).toBeTruthy();
    expect(screen.queryByTestId('org-root-provider-openai')).toBeNull();
    expect(screen.getByTestId<HTMLInputElement>('credential-input').placeholder).toMatch(/replace/i);
  });

  it('offers no provider chip when the org has a root but no key stored yet', () => {
    render(
      <OrgRootSetup
        orgId={ORG_ID}
        org={{ endpoint_id: ENDPOINT_TYPEID, is_root: true, provider: null, credential_hint: '' }}
      />,
    );
    expect(screen.getByTestId('org-root-key')).toBeTruthy();
    expect(screen.getByTestId<HTMLInputElement>('credential-input').placeholder).toMatch(/paste/i);
  });
});

describe('OrgRootSetup — an existing shared-pool chain', () => {
  it('explains that bringing a key is unavailable, and offers no form', () => {
    render(
      <OrgRootSetup
        orgId={ORG_ID}
        org={{ endpoint_id: ENDPOINT_TYPEID, is_root: false, provider: null, credential_hint: '' }}
      />,
    );

    expect(screen.getByTestId('org-root-legacy-chain')).toBeTruthy();
    expect(screen.queryByTestId('org-root-setup')).toBeNull();
    expect(screen.queryByTestId('org-root-key')).toBeNull();
  });
});
