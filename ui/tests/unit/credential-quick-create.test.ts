/**
 * The quick-create "Secret" tile uses the same form and the same save as
 * Connections → Custom API key. The name-only `+` on the assets page declares
 * one variable, in the scope the chips chose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  save: vi.fn((req?: { scope?: string; project_id?: string | null }) =>
    Promise.resolve({
      typeid: 'credential_spec-1',
      title: 'Stripe',
      scope: req?.scope ?? 'user',
      project_id: req?.project_id ?? null,
    }),
  ),
}));

vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  credentialsService: { save: h.save, setValues: vi.fn(), remove: vi.fn(), status: vi.fn() },
}));

import { CredentialSpec, Project } from '@sdk';
import { getDescriptor } from '@src/components/quick-create/registry';
import { CredentialQuickCreateDialog } from '@src/components/credentials/CredentialQuickCreateDialog';

describe('the Secret quick-create entry', () => {
  beforeEach(() => h.save.mockClear());

  it('opens the one credential dialog, in user or project scope', () => {
    const d = getDescriptor(CredentialSpec.type);

    expect(d?.Dialog).toBe(CredentialQuickCreateDialog);
    expect(d?.allowedScopes).toEqual(['user', 'project']);
  });

  it('a name-only create declares one env-file variable for the user', async () => {
    await getDescriptor(CredentialSpec.type)!.create({ project: null, name: ' Stripe key ', scope: 'user' });

    expect(h.save).toHaveBeenCalledWith({
      scope: 'user',
      project_id: null,
      manifest: { name: 'stripe-key', title: 'Stripe key', value_store: 'env', vars: { STRIPE_KEY: { label: 'Stripe key' } } },
    });
  });

  it('a project-scope create declares it on that project', async () => {
    const project = new Project({ id: '2bb0cf90-157a-4ba7-9c1c-99c0ddeedb6d', name: 'p' });

    const result = await getDescriptor(CredentialSpec.type)!.create({ project, name: 'Twilio', scope: 'project' });

    expect(h.save.mock.calls[0][0]).toMatchObject({ scope: 'project', project_id: project.id });
    expect(result.pointer).toBeDefined();
  });
});
