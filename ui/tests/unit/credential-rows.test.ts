/**
 * The Connections table's credential fold. Every decision about presence is the
 * backend's; these pin how its status is shaped for the table — and, most of
 * all, which `.env.local` keys are offered for packing.
 */
import { describe, expect, it } from 'vitest';
import { groupSatisfied, missingNeeds, type CredentialStatusRow, type CredentialsStatus } from '@sdk';
import {
  buildCredentialRows,
  buildDetectedGroups,
  takenInScope,
} from '@src/components/credentials-view/credential-rows';

const row = (over: Partial<CredentialStatusRow> & Pick<CredentialStatusRow, 'name' | 'scope'>): CredentialStatusRow => ({
  typeid: `credential-${over.scope}-${over.name}`,
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
  required: 'MUST',
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
  it('points an env-file credential at its scope\'s .env.local, when that file exists', () => {
    const file = (scope: 'user' | 'project', exists: boolean) => ({
      scope,
      project_id: scope === 'project' ? 'p1' : null,
      path: scope === 'project' ? '/p/.env.local' : '/home/.env.local',
      exists,
      blocked: false,
      block_code: null,
      block_reason: null,
      detected: [],
    });
    const rows = buildCredentialRows(
      status({
        credentials: [
          row({ name: 'proj-env', scope: 'project' }),
          row({ name: 'proj-vault', scope: 'project', value_store: 'vault' }),
          row({ name: 'user-env', scope: 'user' }),
        ],
        files: [file('project', true), file('user', false)],
      }),
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.envPath]));

    expect(byName).toEqual({ 'proj-env': '/p/.env.local', 'proj-vault': undefined, 'user-env': undefined });
  });

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

  /** What a row still needs, as the table words it: one entry per need. */
  const needs = (r: { vars: Parameters<typeof missingNeeds>[0] }) =>
    missingNeeds(r.vars as { envVar: string; present: boolean }[]).map((need) => need.map((x) => x.envVar));

  it('a credential without its required values needs values, and says which', () => {
    const [r] = buildCredentialRows(
      status({
        credentials: [
          row({
            name: 'twilio',
            scope: 'project',
            state: 'partial',
            vars: [v('SID'), v('TOKEN', { present: false, warning: 'missing' }), v('OPTIONAL', { required: 'OPTIONAL', present: false })],
          }),
        ],
      }),
    );

    expect(r.state).toBe('needs-values');
    expect(needs(r)).toEqual([['TOKEN']]);
  });

  it('a credential is MUST when any variable is, OPTIONAL when none is', () => {
    const [must, optional] = buildCredentialRows(
      status({
        credentials: [
          row({ name: 'a-must', scope: 'project', vars: [v('A'), v('B', { required: 'OPTIONAL' })] }),
          row({ name: 'b-optional', scope: 'project', vars: [v('C', { required: 'OPTIONAL' })] }),
        ],
      }),
    );

    expect([must.required, optional.required]).toEqual(['MUST', 'OPTIONAL']);
    expect(must.vars.map((x) => x.required)).toEqual(['MUST', 'OPTIONAL']);
  });

  it('an either-or group makes the credential MUST, and its members stay ONE_OF', () => {
    const [r] = buildCredentialRows(
      status({ credentials: [row({ name: 'gcp', scope: 'project', vars: [v('KEY_FILE', { required: 'ONE_OF' }), v('ADC', { required: 'ONE_OF', kind: 'cli' })] })] }),
    );

    expect(r.required).toBe('MUST');
    expect(r.vars.map((x) => x.required)).toEqual(['ONE_OF', 'ONE_OF']);
  });

  it('a group with no member set is ONE need naming all its members; one member set needs none', () => {
    const group = (keyFile: boolean, adc: boolean) =>
      row({
        name: 'gcp',
        scope: 'project',
        vars: [
          v('PROJECT', { present: false }),
          v('KEY_FILE', { required: 'ONE_OF', present: keyFile }),
          v('ADC', { required: 'ONE_OF', kind: 'cli', store: 'cli', present: adc, found_in: null }),
        ],
      });
    const [none] = buildCredentialRows(status({ credentials: [group(false, false)] }));
    const [one] = buildCredentialRows(status({ credentials: [group(false, true)] }));

    expect(needs(none)).toEqual([['PROJECT'], ['KEY_FILE', 'ADC']]);
    expect(needs(one)).toEqual([['PROJECT']]);
  });

  it('a way of several members holds the group only once every member is there', () => {
    const paired = (address: boolean, password: boolean) =>
      row({
        name: 'gmail',
        scope: 'project',
        vars: [
          v('GMAIL_GOOGLE', { required: 'ONE_OF', kind: 'oauth', store: 'connection', present: false, found_in: null, way: 'google' }),
          v('GMAIL_ADDRESS', { required: 'ONE_OF', present: address, way: 'app_password' }),
          v('GMAIL_APP_PASSWORD', { required: 'ONE_OF', present: password, way: 'app_password' }),
        ],
      });
    const [half] = buildCredentialRows(status({ credentials: [paired(true, false)] }));
    const [whole] = buildCredentialRows(status({ credentials: [paired(true, true)] }));

    expect(needs(half)).toEqual([['GMAIL_GOOGLE', 'GMAIL_ADDRESS', 'GMAIL_APP_PASSWORD']]);
    expect(needs(whole)).toEqual([]);
    expect(groupSatisfied(paired(true, true).vars, 'app_password')).toBe(true);
    expect(groupSatisfied(paired(true, true).vars, 'GMAIL_APP_PASSWORD')).toBe(true);
    expect(groupSatisfied(paired(true, true).vars, 'google')).toBe(false);
  });

  it('keys rows by typeid, so the same name in both scopes is two rows', () => {
    const rows = buildCredentialRows(
      status({ credentials: [row({ name: 'stripe', scope: 'user' }), row({ name: 'stripe', scope: 'project' })] }),
    );

    expect(new Set(rows.map((r) => r.typeid)).size).toBe(2);
  });

  it('marks a user credential overridden when the project declares all its variables', () => {
    const [r] = buildCredentialRows(
      status({ credentials: [row({ name: 'mine', scope: 'user', vars: [v('K', { shadowed_by: 'credential-x' })] })] }),
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
    expect([...takenInScope(s, 'user', 'credential-user-a')]).toEqual([]);
  });
});

describe('buildDetectedGroups', () => {
  it('keeps declared variables and their saved details editable', () => {
    const groups = buildDetectedGroups(status({
      credentials: [row({ scope: 'user', project_id: null, vars: [{ ...v('TOKEN'), label: 'My token', hint: 'From settings', secret: false }] })],
      files: [{ scope: 'user', project_id: null, path: '/h/.env.local', exists: true, blocked: false,
        block_code: null, block_reason: null, detected: [{ key: 'TOKEN', line: 3 }] }],
    }), true);
    expect(groups[0].keys[0]).toMatchObject({ key: 'TOKEN', line: 3, spec: { label: 'My token', hint: 'From settings', secret: false } });
  });

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

  it('groups a project-declared env file on its own, by its project path, without what an earlier file lists', () => {
    const keys = (...names: string[]) => names.map((key, i) => ({ key, line: i + 1 }));
    const groups = buildDetectedGroups(
      status({
        files: [
          {
            scope: 'project',
            project_id: 'p1',
            environment: 'development',
            path: '/p/.env.local',
            exists: true,
            blocked: false,
            block_code: null,
            block_reason: null,
            detected: keys('ROOT', 'BOTH'),
            fallbacks: [{ path: '/p/backend/.env', extra_path: 'backend/.env', exists: true, detected: keys('BOTH', 'BACK') }],
          },
        ],
      }),
    );

    expect(groups.map((g) => [g.path, g.name, g.keys.map((k) => k.key)])).toEqual([
      ['/p/.env.local', '.env.local', ['ROOT', 'BOTH']],
      // BOTH is read from the root file; offering it again would pack one key twice.
      ['/p/backend/.env', 'backend/.env', ['BACK']],
    ]);
  });
});

describe('buildCredentialRows — an oauth credential', () => {
  it('is a credential row of kind oauth: its provider, the scopes it needs, those the grant lacks, needed whole', () => {
    const [google] = buildCredentialRows(
      status({
        credentials: [
          row({ typeid: 'credential-g', name: 'google', scope: 'project', value_store: 'connection', kind: 'oauth', provider: 'Google',
                scopes: ['drive.readonly'], missing_scopes: ['drive'], state: 'partial', vars: [] }),
        ],
      }),
    );
    expect(google).toMatchObject({
      typeid: 'credential-g', kind: 'oauth', provider: 'google', scopes: ['drive.readonly'], missingScopes: ['drive'],
      required: 'MUST', state: 'needs-values',
    });
  });

  it('leaves an env credential an env credential', () => {
    const [key] = buildCredentialRows(status({ credentials: [row({ name: 'openai', scope: 'user', vars: [v('OPENAI_API_KEY')] })] }));
    expect(key.kind).toBe('env');
    expect(key.scopes).toEqual([]);
  });
});
