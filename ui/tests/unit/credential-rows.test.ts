/**
 * The Connections table's credential fold.
 *
 * The behaviour worth pinning is the two-input union: `secret-resolve-status`
 * only knows about DECLARATIONS, so a value sitting undeclared in `.env.local`
 * is invisible to it. Folding on that alone reports "0 of 2" on a machine where
 * both values are in the file.
 */
import { describe, it, expect } from 'vitest';
import { CredentialSpec } from '@sdk';
import type { EnvLocalKey, ProjectSecretOriginSummary, SecretResolveStatus } from '@sdk';

import { buildCredentialRows } from '@src/components/credentials-view/credential-rows';

const gmail = () =>
  new CredentialSpec({
    id: '11111111-2222-4333-8444-555555555555',
    type: 'credential_spec',
    name: 'gmail',
    title: 'Gmail',
    icon_name: 'Mail',
    vars: {
      GMAIL_ADDRESS: { label: 'Gmail address', secret: false },
      GMAIL_APP_PASSWORD: { label: 'App password', secret: true },
    },
  } as never);

const declaration = (envVar: string): ProjectSecretOriginSummary => ({
  typeid: `secret_origin-${envVar}`,
  name: envVar,
  env_var: envVar,
  kind: 'env-local',
  locator: { kind: 'env-local', env_key: envVar } as never,
  scope: 'private',
});

const resolved = (envVar: string, status: 'available' | 'missing'): SecretResolveStatus =>
  ({
    typeid: `secret_origin-${envVar}`,
    name: envVar,
    env_var: envVar,
    kind: 'env-local',
    scope: 'private',
    sod_store: 'env-local',
    status,
    found_in: status === 'available' ? 'env-local' : null,
    setup_hint: { kind: 'env-local', sod_store: 'env-local', provider_label: '', prompt: '' },
  }) as SecretResolveStatus;

const onDisk = (key: string, line: number): EnvLocalKey => ({ key, line, declared: false });

const build = (over: Partial<Parameters<typeof buildCredentialRows>[0]> = {}) =>
  buildCredentialRows({
    specs: [gmail()],
    secretOrigins: [],
    status: [],
    envLocalKeys: [],
    ...over,
  });

describe('buildCredentialRows', () => {
  it('keeps a provider with nothing declared and nothing on disk out of the table', () => {
    // "Only existing things" — the full catalogue lives behind Add connection.
    expect(build()).toEqual([]);
  });

  it('reads connected when every required member is declared and resolvable', () => {
    const rows = build({
      secretOrigins: [declaration('GMAIL_ADDRESS'), declaration('GMAIL_APP_PASSWORD')],
      status: [resolved('GMAIL_ADDRESS', 'available'), resolved('GMAIL_APP_PASSWORD', 'available')],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('connected');
    expect(rows[0].metCount).toBe(2);
    expect(rows[0].requiredCount).toBe(2);
  });

  it('is not a row at all when only some of its values are there', () => {
    // A credential EXISTS when its values do. Half a credential does not work,
    // so it is not shown as a half-state — it stays in the Add dialog.
    const rows = build({
      secretOrigins: [declaration('GMAIL_APP_PASSWORD')],
      status: [resolved('GMAIL_APP_PASSWORD', 'available')],
    });

    expect(rows).toEqual([]);
  });

  it('is not a row when it is declared but no value was ever supplied', () => {
    // The ghost this rule exists to kill: adding a credential and never filling
    // it used to leave a row reading "0 of 2" that nothing could use.
    const rows = build({
      secretOrigins: [declaration('GMAIL_ADDRESS'), declaration('GMAIL_APP_PASSWORD')],
      status: [resolved('GMAIL_ADDRESS', 'missing'), resolved('GMAIL_APP_PASSWORD', 'missing')],
    });

    expect(rows).toEqual([]);
  });

  it('surfaces a provider whose values are on disk but undeclared', () => {
    // The whole reason the fold takes two inputs. resolve-status is empty here.
    const rows = build({
      envLocalKeys: [onDisk('GMAIL_APP_PASSWORD', 43), onDisk('GMAIL_ADDRESS', 44)],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].adoptableCount).toBe(2);
    expect(rows[0].members.map((m) => m.state)).toEqual(['adoptable', 'adoptable']);
    // Adoptable is NOT met: the worker resolver iterates declarations, so an
    // undeclared value is never injected however plainly it sits in the file.
    expect(rows[0].metCount).toBe(0);
    expect(rows[0].state).toBe('partial');
  });

  it('carries the .env.local line through for the editor deep-link', () => {
    const rows = build({
      envLocalKeys: [onDisk('GMAIL_ADDRESS', 44), onDisk('GMAIL_APP_PASSWORD', 43)],
    });

    expect(rows[0].members.find((m) => m.envVar === 'GMAIL_ADDRESS')?.line).toBe(44);
  });

  it('keeps the secret/plain distinction that drives masking', () => {
    const rows = build({
      envLocalKeys: [onDisk('GMAIL_ADDRESS', 44), onDisk('GMAIL_APP_PASSWORD', 43)],
    });
    const byVar = Object.fromEntries(rows[0].members.map((m) => [m.envVar, m]));

    expect(byVar.GMAIL_ADDRESS.secret).toBe(false);
    expect(byVar.GMAIL_APP_PASSWORD.secret).toBe(true);
  });

  it('treats an unclaimed declaration as a one-member ad-hoc row', () => {
    const rows = build({
      secretOrigins: [declaration('STRIPE_KEY')],
      status: [resolved('STRIPE_KEY', 'available')],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'STRIPE_KEY', adHoc: true, state: 'connected' });
    // A bare declaration defaults to required+secret, the safe direction.
    expect(rows[0].members[0]).toMatchObject({ required: true, secret: true });
  });

  it('does not promote undeclared non-credential keys to rows', () => {
    // A .env.local holds ports and flags too; a row per line buries the real
    // credentials.
    const rows = build({
      envLocalKeys: [onDisk('VITE_PORT', 14), onDisk('LOCAL_SERVER_PORT', 6)],
    });

    expect(rows).toEqual([]);
  });

  it('orders known providers before ad-hoc rows', () => {
    const rows = build({
      secretOrigins: [
        declaration('AAA_KEY'),
        declaration('GMAIL_ADDRESS'),
        declaration('GMAIL_APP_PASSWORD'),
      ],
      status: [
        resolved('AAA_KEY', 'available'),
        resolved('GMAIL_ADDRESS', 'available'),
        resolved('GMAIL_APP_PASSWORD', 'available'),
      ],
    });

    expect(rows.map((r) => r.key)).toEqual(['gmail', 'AAA_KEY']);
  });
});

describe('CredentialSpec row mirror', () => {
  it('populates vars from a list-query payload', () => {
    // The deepAssign cache-MISS path: without the hand-written constructor
    // `vars` arrives {} and every credential renders with zero members.
    expect(gmail().varNames).toEqual(['GMAIL_ADDRESS', 'GMAIL_APP_PASSWORD']);
  });

  it('treats an omitted required/secret as true', () => {
    const spec = new CredentialSpec({
      id: '66666666-7777-4888-8999-aaaaaaaaaaaa',
      type: 'credential_spec',
      name: 'twilio',
      vars: { TWILIO_AUTH_TOKEN: {} },
    } as never);

    expect(spec.requiredVarNames).toEqual(['TWILIO_AUTH_TOKEN']);
  });
});

/**
 * An LLM provider key is the same row with a different destination.
 *
 * The store is not cosmetic here: a key declared into `.env.local` is invisible
 * to the LLM funding resolver, which tests the encrypted store for a secret
 * named `lm_api.<provider>`. So the row has to carry where its values go, and
 * `locatorFor` has to point the declaration there.
 */
describe('an lm_provider credential', () => {
  const openrouter = () =>
    new CredentialSpec({
      id: '99999999-8888-4777-8666-555555555555',
      type: 'credential_spec',
      name: 'openrouter',
      title: 'OpenRouter',
      icon_name: 'BrainCircuit',
      lm_provider: 'openrouter',
      default_store: 'sodot',
      vars: {
        OPENROUTER_API_KEY: { label: 'API key', secret: true, sod_name: 'lm_api.openrouter' },
      },
    } as never);

  it('declares into the encrypted store under the name funding reads', () => {
    expect(openrouter().locatorFor('OPENROUTER_API_KEY')).toEqual({
      kind: 'local',
      sod_name: 'lm_api.openrouter',
    });
    expect(openrouter().sodStore).toBe('sodot');
  });

  it('leaves an env-local credential pointing at its env key', () => {
    expect(gmail().locatorFor('GMAIL_ADDRESS')).toEqual({
      kind: 'env-local',
      env_key: 'GMAIL_ADDRESS',
    });
    expect(gmail().sodStore).toBe('env-local');
  });

  it('folds to the same states as an env-local row, and carries its store', () => {
    const rows = buildCredentialRows({
      specs: [openrouter()],
      secretOrigins: [declaration('OPENROUTER_API_KEY')],
      status: [resolved('OPENROUTER_API_KEY', 'available')],
      envLocalKeys: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('connected');
    // What the setup panel reads to decide which reassurance it may print.
    expect(rows[0].sodStore).toBe('sodot');
  });

  it('is not adopted from .env.local — that is a file this credential never reads', () => {
    // A key exported as OPENROUTER_API_KEY is a convenience for in-process
    // calls, deliberately NOT a statement about what this box may spend
    // (llm_source.py). Counting it as "detected" offered an Add that could only
    // mint a declaration pointing at an empty store, so the credential stays
    // where an unconnected one belongs: in the Add connection picker.
    const rows = buildCredentialRows({
      specs: [openrouter()],
      secretOrigins: [],
      status: [],
      envLocalKeys: [onDisk('OPENROUTER_API_KEY', 7)],
    });

    expect(rows).toHaveLength(0);
  });

  it('still adopts an env-local credential whose values are on disk', () => {
    const rows = buildCredentialRows({
      specs: [gmail()],
      secretOrigins: [],
      status: [],
      envLocalKeys: [onDisk('GMAIL_ADDRESS', 1), onDisk('GMAIL_APP_PASSWORD', 2)],
    });

    expect(rows[0].adoptableCount).toBe(2);
  });
});
