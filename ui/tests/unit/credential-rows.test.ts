/**
 * The Connections table's credential fold. Every decision about presence is the
 * backend's; these pin how its status is shaped for the table — and, most of
 * all, which `.env.local` keys are offered for packing.
 */
import { describe, expect, it } from 'vitest';
import type { CredentialStatusRow, CredentialsStatus } from '@sdk';
import {
  buildCredentialRows,
  buildDetectedGroups,
  takenInScope,
} from '@src/components/credentials-view/credential-rows';

const row = (over: Partial<CredentialStatusRow> & Pick<CredentialStatusRow, 'name' | 'scope'>): CredentialStatusRow => ({
  typeid: `credential_spec-${over.scope}-${over.name}`,
  title: over.name,
  description: '',
  icon_name: '',
  help_url: '',
  project_id: over.scope === 'project' ? 'p1' : null,
  value_store: 'env',
  lm_provider: '',
  state: 'connected',
  vars: [],
  ...over,
});

const v = (env_var: string, over: Partial<CredentialStatusRow['vars'][number]> = {}) => ({
  env_var,
  label: '',
  hint: '',
  placeholder: '',
  pattern: '',
  help_url: '',
  secret: true,
  required: true,
  present: true,
  found_in: 'env' as const,
  warning: null,
  shadowed_by: null,
  ...over,
});

const status = (over: Partial<CredentialsStatus> = {}): CredentialsStatus => ({
  project_id: 'p1',
  vault_enabled: true,
  credentials: [],
  files: [],
  ...over,
});

describe('buildCredentialRows', () => {
  it('lists every declared credential, the project’s before the user’s', () => {
    const rows = buildCredentialRows(
      status({
        credentials: [
          row({ name: 'personal', scope: 'user', vars: [v('A')] }),
          row({ name: 'zeta', scope: 'project', vars: [v('Z')] }),
          row({ name: 'alpha', scope: 'project', vars: [v('B')] }),
        ],
      }),
    );

    expect(rows.map((r) => `${r.scope}:${r.name}`)).toEqual(['project:alpha', 'project:zeta', 'user:personal']);
  });

  it('a credential without its required values needs values, and says which', () => {
    const [r] = buildCredentialRows(
      status({
        credentials: [
          row({
            name: 'twilio',
            scope: 'project',
            state: 'partial',
            vars: [v('SID'), v('TOKEN', { present: false, warning: 'missing' }), v('OPTIONAL', { required: false, present: false })],
          }),
        ],
      }),
    );

    expect(r.state).toBe('needs-values');
    expect(r.missing).toEqual(['TOKEN']);
  });

  it('keys rows by typeid, so the same name in both scopes is two rows', () => {
    const rows = buildCredentialRows(
      status({ credentials: [row({ name: 'stripe', scope: 'user' }), row({ name: 'stripe', scope: 'project' })] }),
    );

    expect(new Set(rows.map((r) => r.typeid)).size).toBe(2);
  });

  it('marks a user credential overridden when the project declares all its variables', () => {
    const [r] = buildCredentialRows(
      status({ credentials: [row({ name: 'mine', scope: 'user', vars: [v('K', { shadowed_by: 'credential_spec-x' })] })] }),
    );

    expect(r.shadowed).toBe(true);
  });
});

describe('takenInScope', () => {
  it('collects variables declared in that scope only, optionally ignoring one credential', () => {
    const s = status({
      credentials: [
        row({ name: 'a', scope: 'user', vars: [v('USER_KEY')] }),
        row({ name: 'b', scope: 'project', vars: [v('PROJ_KEY')] }),
      ],
    });

    expect([...takenInScope(s, 'user')]).toEqual(['USER_KEY']);
    expect([...takenInScope(s, 'user', 'credential_spec-user-a')]).toEqual([]);
  });
});

describe('buildDetectedGroups', () => {
  it('offers only keys no credential in that scope declares', () => {
    const groups = buildDetectedGroups(
      status({
        credentials: [
          row({ name: 'packed', scope: 'project', vars: [v('PACKED')] }),
          row({ name: 'vaulted', scope: 'project', value_store: 'vault', vars: [v('IN_VAULT')] }),
        ],
        files: [
          {
            scope: 'project',
            project_id: 'p1',
            path: '/p/.env.local',
            exists: true,
            blocked: false,
            block_code: null,
            block_reason: null,
            detected: [
              { key: 'FREE', line: 1 },
              { key: 'PACKED', line: 2 },
              // Declared by a vault credential: packing it again would clash.
              { key: 'IN_VAULT', line: 3 },
            ],
          },
        ],
      }),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].keys).toEqual([{ key: 'FREE', line: 1 }]);
  });

  it('leaves out a scope whose file has nothing left to pack', () => {
    const groups = buildDetectedGroups(
      status({
        files: [
          { scope: 'user', project_id: null, path: '/h/.env.local', exists: true, blocked: false, block_code: null, block_reason: null, detected: [] },
        ],
      }),
    );

    expect(groups).toEqual([]);
  });
});
