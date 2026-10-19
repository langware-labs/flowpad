/**
 * `PayingProviderSetup` — bringing your own provider key at the organization level.
 *
 * The whole point of this component: an admin creating a new organization and allocating money
 * never has to visit the expert LLM Endpoints page first. Submitting here is two hub calls in
 * sequence (create the root, then store the key on the id that returns) — and a failure in the
 * SECOND call must be distinguishable from a failure in the first, because the first one already
 * landed and re-submitting it would be wrong.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  setCredential: vi.fn(),
  invalidate: vi.fn(() => Promise.resolve()),
  del: vi.fn(() => Promise.resolve()),
}));

vi.mock('@src/components/organization/budgets/use-budgets', () => ({
  useSetPayingProvider: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
  useInvalidateBudgets: () => h.invalidate,
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    llmEndpointsService: { ...(actual.llmEndpointsService as object), setCredential: h.setCredential },
    dataManager: { ...(actual.dataManager as object), delete: h.del },
  };
});

import { PayingProviderSetup } from '@src/components/organization/budgets/PayingProviderSetup';

// Radix Select opens through pointer capture and keeps the active item in view; jsdom
// implements neither, so without these the provider dropdown never opens. Same stubs as
// `vibe-worker-select.test.tsx` — the unit tier's setup carries none of them.
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

const ORG_ID = '550e8400-e29b-41d4-a716-446655440000';
const ENDPOINT_TYPEID = 'llm_endpoint-550e8400-e29b-41d4-a716-446655440099';
const ENDPOINT_BARE = '550e8400-e29b-41d4-a716-446655440099';
// Real length and real prefixes: the field refuses a key whose SHAPE is wrong for the provider,
// so a toy string like 'sk-or-secret' is now (correctly) rejected before it is ever sent.
const ANTHROPIC_KEY = `sk-ant-api03-${'b'.repeat(40)}`;
const OPENROUTER_KEY = `sk-or-v1-${'a'.repeat(40)}`;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PayingProviderSetup — no budget yet', () => {
  const org = {
    endpoint_id: null,
    is_root: false,
    provider: null,
    credential_hint: '',
    can_set_credential: true,
    can_set_up_budget: true,
  };

  it('defaults to the first provider and lets another be picked from the dropdown', async () => {
    const user = userEvent.setup();
    render(<PayingProviderSetup orgId={ORG_ID} org={org} />);

    expect(screen.getByTestId('org-root-provider').textContent).toContain('OpenRouter');
    await user.click(screen.getByTestId('org-root-provider'));
    await user.click(await screen.findByTestId('org-root-provider-anthropic'));
    expect(screen.getByTestId('org-root-provider').textContent).toContain('Anthropic');
  });

  it('does nothing when Activate is pressed with no key typed', () => {
    render(<PayingProviderSetup orgId={ORG_ID} org={org} />);
    expect(screen.getByTestId('org-root-activate')).toHaveProperty('disabled', true);
    expect(h.mutateAsync).not.toHaveBeenCalled();
  });

  it('creates the root then stores the key, in that order, with the chosen provider', async () => {
    h.mutateAsync.mockResolvedValue({ endpoint_id: ENDPOINT_TYPEID, created: true, rebased: 0 });
    h.setCredential.mockResolvedValue({
      ok: true,
      credential_hint: '****abcd',
      can_set_credential: true,
      can_set_up_budget: true,
    });
    const user = userEvent.setup();
    render(<PayingProviderSetup orgId={ORG_ID} org={org} />);

    await user.click(screen.getByTestId('org-root-provider'));
    await user.click(await screen.findByTestId('org-root-provider-anthropic'));
    fireEvent.change(screen.getByTestId('credential-input'), { target: { value: ANTHROPIC_KEY } });
    fireEvent.click(screen.getByTestId('org-root-activate'));

    await waitFor(() => expect(h.setCredential).toHaveBeenCalled());
    expect(h.mutateAsync).toHaveBeenCalledWith({
      orgId: ORG_ID,
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(h.setCredential).toHaveBeenCalledWith(ENDPOINT_BARE, ANTHROPIC_KEY);
    // The order matters: the key can only be stored once the id creating it returns.
    const rootCallOrder = h.mutateAsync.mock.invocationCallOrder[0];
    const credentialCallOrder = h.setCredential.mock.invocationCallOrder[0];
    expect(rootCallOrder).toBeLessThan(credentialCallOrder);
  });

  it('trims the key before sending it', async () => {
    h.mutateAsync.mockResolvedValue({ endpoint_id: ENDPOINT_TYPEID, created: true, rebased: 0 });
    h.setCredential.mockResolvedValue({
      ok: true,
      credential_hint: '****abcd',
      can_set_credential: true,
      can_set_up_budget: true,
    });
    render(<PayingProviderSetup orgId={ORG_ID} org={org} />);

    fireEvent.change(screen.getByTestId('credential-input'), { target: { value: `  ${OPENROUTER_KEY}  ` } });
    fireEvent.click(screen.getByTestId('org-root-activate'));

    await waitFor(() => expect(h.setCredential).toHaveBeenCalledWith(ENDPOINT_BARE, OPENROUTER_KEY));
  });

  it('reports it distinctly when the root is created but the key fails to store', async () => {
    h.mutateAsync.mockResolvedValue({ endpoint_id: ENDPOINT_TYPEID, created: true, rebased: 0 });
    h.setCredential.mockRejectedValue(new Error('network blip'));
    render(<PayingProviderSetup orgId={ORG_ID} org={org} />);

    fireEvent.change(screen.getByTestId('credential-input'), { target: { value: OPENROUTER_KEY } });
    fireEvent.click(screen.getByTestId('org-root-activate'));

    await waitFor(() => expect(h.setCredential).toHaveBeenCalled());
    // The mutation resolved (the root exists); only the key call rejected. Nothing here re-throws
    // that as "could not create the organization".
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('reports plainly when creating the root itself fails, and never calls setCredential', async () => {
    h.mutateAsync.mockRejectedValue(new Error('this organization already draws its budget from a shared pool'));
    render(<PayingProviderSetup orgId={ORG_ID} org={org} />);

    fireEvent.change(screen.getByTestId('credential-input'), { target: { value: OPENROUTER_KEY } });
    fireEvent.click(screen.getByTestId('org-root-activate'));

    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalled());
    expect(h.setCredential).not.toHaveBeenCalled();
  });
});

/**
 * The budgets action answers with a PREFIXED typeid; the credential calls build
 * `new TypeId('llm_endpoint', id)` and want the BARE uuid. Passing the prefixed form through made
 * that constructor throw inside the service call before any HTTP — a dead Save button, no network
 * request, and `Invalid (0)` from Test's own catch.
 */
describe('PayingProviderSetup — the hub sends a prefixed typeid, the credential calls want a bare id', () => {
  it('hands CredentialField the bare uuid for an org that already has a root', () => {
    render(
      <PayingProviderSetup
        orgId={ORG_ID}
        org={{
          endpoint_id: ENDPOINT_TYPEID,
          is_root: true,
          provider: 'openai',
          credential_hint: '',
          can_set_credential: true,
          can_set_up_budget: true,
        }}
      />,
    );

    fireEvent.change(screen.getByTestId('credential-input'), { target: { value: `sk-proj-${'c'.repeat(40)}` } });
    fireEvent.click(screen.getByTestId('credential-save'));

    expect(h.setCredential).toHaveBeenCalledWith(ENDPOINT_BARE, `sk-proj-${'c'.repeat(40)}`);
  });
});

describe('PayingProviderSetup — already a root', () => {
  /**
   * The provider control is SHOWN and disabled, not hidden. The hub refuses to change
   * `provider`/`base_url` once the endpoint exists, so an open dropdown would be a form that lies —
   * but hiding it answers "which provider is this org on?" with nothing. Disabled says both, and
   * matches what the expert dialog does on edit.
   */
  it('shows the provider, locked, alongside the masked hint', () => {
    render(
      <PayingProviderSetup
        orgId={ORG_ID}
        org={{
          endpoint_id: ENDPOINT_TYPEID,
          is_root: true,
          provider: 'openai',
          credential_hint: '****z9z9',
          can_set_credential: true,
          can_set_up_budget: true,
        }}
      />,
    );

    expect(screen.getByTestId('org-root-key')).toBeTruthy();
    const picker = screen.getByTestId<HTMLButtonElement>('org-root-provider');
    expect(picker.textContent).toContain('OpenAI');
    expect(picker.disabled).toBe(true);
    expect(screen.getByTestId<HTMLInputElement>('credential-input').placeholder).toMatch(/replace/i);
  });

  it('cannot be opened when locked — a disabled trigger reveals no options', async () => {
    const user = userEvent.setup();
    render(
      <PayingProviderSetup
        orgId={ORG_ID}
        org={{
          endpoint_id: ENDPOINT_TYPEID,
          is_root: true,
          provider: 'openai',
          credential_hint: '****z9z9',
          can_set_credential: true,
          can_set_up_budget: true,
        }}
      />,
    );

    await user.click(screen.getByTestId('org-root-provider'));
    expect(screen.queryByTestId('org-root-provider-anthropic')).toBeNull();
  });

  it('offers no provider chip when the org has a root but no key stored yet', () => {
    render(
      <PayingProviderSetup
        orgId={ORG_ID}
        org={{
          endpoint_id: ENDPOINT_TYPEID,
          is_root: true,
          provider: null,
          credential_hint: '',
          can_set_credential: true,
          can_set_up_budget: true,
        }}
      />,
    );
    expect(screen.getByTestId('org-root-key')).toBeTruthy();
    expect(screen.getByTestId<HTMLInputElement>('credential-input').placeholder).toMatch(/paste/i);
  });
});

/**
 * `provider` and `base_url` are in the hub's `_immutable_update`, so moving an organization to a
 * different provider means deleting its root and building another. Deleting the stored KEY does
 * not do that — it clears the credential and leaves the endpoint — which is why a key delete looks
 * like it changes nothing about the locked dropdown. This is the control that actually does it.
 */
describe('PayingProviderSetup — moving to a different provider', () => {
  it('asks first, then deletes the root so the provider picker comes back', async () => {
    render(
      <PayingProviderSetup
        orgId={ORG_ID}
        org={{
          endpoint_id: ENDPOINT_TYPEID,
          is_root: true,
          provider: 'openrouter',
          credential_hint: '',
          can_set_credential: true,
          can_set_up_budget: true,
        }}
      />,
    );

    fireEvent.click(screen.getByTestId('org-root-replace'));
    expect(h.del).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove budget' }));
    await waitFor(() => expect(h.del).toHaveBeenCalled());
    // The ENDPOINT, by its bare uuid — not the organization.
    expect(h.del.mock.calls[0][0]).toEqual(expect.objectContaining({ type: 'llm_endpoint', id: ENDPOINT_BARE }));
    await waitFor(() => expect(h.invalidate).toHaveBeenCalled());
  });

  it('offers the way out even while a key is still stored', () => {
    render(
      <PayingProviderSetup
        orgId={ORG_ID}
        org={{
          endpoint_id: ENDPOINT_TYPEID,
          is_root: true,
          provider: 'openrouter',
          credential_hint: '****wxyz',
          can_set_credential: true,
          can_set_up_budget: true,
        }}
      />,
    );
    expect(screen.getByTestId('org-root-replace')).toBeTruthy();
  });
});

describe('PayingProviderSetup — an existing shared-pool chain', () => {
  it('explains that bringing a key is unavailable, and offers no form', () => {
    render(
      <PayingProviderSetup
        orgId={ORG_ID}
        org={{
          endpoint_id: ENDPOINT_TYPEID,
          is_root: false,
          provider: null,
          credential_hint: '',
          can_set_credential: true,
          can_set_up_budget: true,
        }}
      />,
    );

    expect(screen.getByTestId('org-root-legacy-chain')).toBeTruthy();
    expect(screen.queryByTestId('org-root-setup')).toBeNull();
    expect(screen.queryByTestId('org-root-key')).toBeNull();
  });
});
