/**
 * Where a credential's values live is a deployment's, never the credential's. The form's Storage
 * choice travels with the save as `store`, applied to the deployment the save is for (this computer
 * when none is named); the manifest carries no store and no environments.
 */
import { describe, expect, it } from 'vitest';
import { credentialEnvFileName, type CredentialStatusRow } from '@sdk';
import { customDraft, editDraft, templateDraft, toSaveRequest } from '@src/components/credentials/credential-draft';

const row = (over: Partial<CredentialStatusRow> = {}): CredentialStatusRow => ({
  typeid: 'credential-1',
  name: 'db',
  title: 'Database',
  description: '',
  icon_name: '',
  help_url: '',
  setup_wiki: '',
  setup: 'x',
  scope: 'project',
  project_id: 'p1',
  environment: 'production',
  value_store: 'vault',
  lm_provider: '',
  state: 'connected',
  vars: [],
  ...over,
});

describe('credential storage belongs to the deployment', () => {
  it('names the env file each environment reads', () => {
    expect(credentialEnvFileName()).toBe('.env.local');
    expect(credentialEnvFileName('development')).toBe('.env.local');
    expect(credentialEnvFileName('production')).toBe('.env.production.local');
  });

  it("a save for this computer sends the form's store and no deployment", () => {
    const request = toSaveRequest({ ...customDraft('project'), title: 'Stripe', store: 'vault' }, 'p1');
    expect(request.store).toBe('vault');
    expect(request).not.toHaveProperty('deployment_id');
    expect(request.manifest).not.toHaveProperty('value_store');
    expect(request.manifest).not.toHaveProperty('environments');
  });

  it('a save for a deployment names it', () => {
    const request = toSaveRequest({ ...customDraft('project'), title: 'Database' }, 'p1', 'deployment-uuid');
    expect(request.deployment_id).toBe('deployment-uuid');
    expect(request.store).toBe('env');
  });

  it('an edit reads where the deployment keeps it, and a split stays split', () => {
    expect(editDraft(row()).store).toBe('vault');
    expect(toSaveRequest(editDraft(row({ value_store: 'mixed' })), 'p1')).not.toHaveProperty('store');
    expect(toSaveRequest(editDraft(row({ value_store: 'gcp_secret_manager' })), 'p1')).not.toHaveProperty('store');
  });

  it('a provider key sends no store: its vault entry is fixed', () => {
    const spec = { name: 'openrouter', title: 'OpenRouter', lm_provider: 'openrouter', varNames: ['OPENROUTER_API_KEY'], vars: {} };
    expect(toSaveRequest(templateDraft(spec as never, 'user'), null)).not.toHaveProperty('store');
  });
});
