/**
 * Credential environments in the form: one declaration, a store per
 * environment. `development` is this computer and keeps the credential's own
 * `value_store`; a named environment overrides it only when asked to, and an
 * edit sends every existing override back so none is dropped.
 */
import { describe, expect, it } from 'vitest';
import { credentialEnvFileName, type CredentialStatusRow } from '@sdk';
import {
  customDraft,
  editDraft,
  storeIn,
  toSaveRequest,
  withStoreIn,
} from '@src/components/credentials/credential-draft';

const row = (over: Partial<CredentialStatusRow> = {}): CredentialStatusRow => ({
  typeid: 'credential_spec-1',
  name: 'db',
  title: 'Database',
  description: '',
  icon_name: '',
  help_url: '',
  scope: 'project',
  project_id: 'p1',
  environment: 'production',
  value_store: 'vault',
  default_value_store: 'env',
  environments: { production: { value_store: 'vault' } },
  lm_provider: '',
  state: 'connected',
  vars: [],
  ...over,
});

describe('credential environments', () => {
  it('names the env file each environment reads', () => {
    expect(credentialEnvFileName()).toBe('.env.local');
    expect(credentialEnvFileName('development')).toBe('.env.local');
    expect(credentialEnvFileName('production')).toBe('.env.production.local');
  });

  it('keeps the credential store for development and overrides only a named environment', () => {
    const d = customDraft('project');
    expect(storeIn(d, 'development')).toBe('env');
    expect(storeIn(d, 'production')).toBe('env');

    const devVault = { ...d, ...withStoreIn(d, 'development', 'vault') };
    expect(devVault.store).toBe('vault');
    expect(devVault.environments).toEqual({});

    const prodVault = { ...d, ...withStoreIn(d, 'production', 'vault') };
    expect(prodVault.store).toBe('env');
    expect(storeIn(prodVault, 'production')).toBe('vault');
    expect(storeIn(prodVault, 'development')).toBe('env');
  });

  it('a development save stays in the original shape', () => {
    const d = { ...customDraft('project'), title: 'Stripe' };
    const request = toSaveRequest(d, 'p1');
    expect(request).not.toHaveProperty('environment');
    expect(request.manifest).not.toHaveProperty('environments');
  });

  it('a named environment save carries the environment and its override', () => {
    const d = { ...customDraft('project'), title: 'Database' };
    const withOverride = { ...d, ...withStoreIn(d, 'production', 'vault') };
    const request = toSaveRequest(withOverride, 'p1', 'production');
    expect(request.environment).toBe('production');
    expect(request.manifest.value_store).toBe('env');
    expect(request.manifest.environments).toEqual({ production: { value_store: 'vault' } });
  });

  it('an edit reads the default store and sends every existing override back', () => {
    const d = editDraft(row());
    expect(d.store).toBe('env');
    expect(storeIn(d, 'production')).toBe('vault');
    expect(toSaveRequest(d, 'p1').manifest.environments).toEqual({ production: { value_store: 'vault' } });
  });
});
