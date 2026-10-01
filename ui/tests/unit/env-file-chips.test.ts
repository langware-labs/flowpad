/**
 * The Credentials header's env-file chips: which files show, in what order, and
 * how two `.env.local` files (the project's and the home folder's) stay apart.
 */
import { describe, expect, it } from 'vitest';
import type { CredentialScopeFile, CredentialsStatus } from '@sdk';
import { envFileChips, envFileLabel } from '@src/components/credentials-view/EnvFileChips';

const file = (over: Partial<CredentialScopeFile> & Pick<CredentialScopeFile, 'scope' | 'path'>): CredentialScopeFile => ({
  project_id: over.scope === 'project' ? 'p1' : null,
  environment: 'development',
  exists: true,
  extra_path: null,
  blocked: false,
  block_code: null,
  block_reason: null,
  detected: [],
  ...over,
});

const status = (files: CredentialScopeFile[]): CredentialsStatus =>
  ({ project_id: 'p1', vault_enabled: true, credentials: [], files }) as unknown as CredentialsStatus;

describe('envFileChips', () => {
  it('puts the project files first, the home folder last, and keeps a missing declared file removable', () => {
    const chips = envFileChips(
      status([
        file({ scope: 'user', path: '/h/.env.local' }),
        file({ scope: 'project', path: '/p/.env.local' }),
        file({ scope: 'project', path: '/p/backend/.env', extra_path: 'backend/.env', exists: false }),
        file({ scope: 'project', path: '/p/gone/.env.local', exists: false }),
      ]),
    );

    expect(chips.map(envFileLabel)).toEqual(['.env.local', 'backend/.env', '~/.env.local']);
  });

  it('names a named environment by its own file', () => {
    expect(envFileLabel(file({ scope: 'project', path: '/p/.env.staging.local', environment: 'staging' }))).toBe(
      '.env.staging.local',
    );
  });
});
