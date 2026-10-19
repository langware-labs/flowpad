/**
 * The one credential form's rules. Every entry point — Custom credentials, a
 * catalogue template, packed `.env.local` keys, the quick-create Secret tile —
 * builds one of these drafts and saves it the same way.
 */
import { describe, expect, it } from 'vitest';
import { Credential, type CredentialStatusRow } from '@sdk';
import {
  asksValues,
  customDraft,
  editDraft,
  emptyVar,
  loginCommands,
  namesLocked,
  packDraft,
  scopeLocked,
  slugify,
  storeLocked,
  templateDraft,
  toEnvVarName,
  toSaveRequest,
  validateDraft,
  valuesDraft,
} from '@src/components/credentials/credential-draft';

const gmail = () =>
  new Credential({
    name: 'gmail',
    title: 'Gmail',
    scope: 'system',
    value_store: 'env',
    vars: {
      GMAIL_ADDRESS: { label: 'Address', secret: false, account_key: true },
      GMAIL_APP_PASSWORD: { label: 'App password', pattern: '^[a-z]{16}$' },
    },
  } as never);

const openrouter = () =>
  new Credential({
    name: 'openrouter',
    title: 'OpenRouter',
    scope: 'system',
    lm_provider: 'openrouter',
    value_store: 'vault',
    vars: { OPENROUTER_API_KEY: { label: 'API key' } },
  } as never);

const statusRow = (over: Partial<CredentialStatusRow> = {}): CredentialStatusRow => ({
  typeid: 'credential-1',
  name: 'stripe',
  title: 'Stripe',
  description: 'Payments',
  icon_name: '',
  help_url: '',
  scope: 'project',
  project_id: 'p1',
  value_store: 'vault',
  lm_provider: '',
  state: 'connected',
  vars: [
    { env_var: 'STRIPE_KEY', label: '', hint: 'secret key', placeholder: '', pattern: '', help_url: '', secret: true, required: 'MUST', present: true, found_in: 'vault', warning: null, shadowed_by: null },
  ],
  ...over,
});

describe('building a draft', () => {
  it('a template keeps its variable names fixed and its scope as chosen', () => {
    const d = templateDraft(gmail(), 'project');

    expect(d.scope).toBe('project');
    expect(d.store).toBe('env');
    expect(d.vars.map((v) => v.envVar)).toEqual(['GMAIL_ADDRESS', 'GMAIL_APP_PASSWORD']);
    expect(d.vars[0].secret).toBe(false);
    expect(namesLocked(d)).toBe(true);
    expect(asksValues(d)).toBe(true);
  });

  it('a provider key is always the user’s, in the vault — and the form cannot change that', () => {
    const d = templateDraft(openrouter(), 'project');

    expect(d.scope).toBe('user');
    expect(d.store).toBe('vault');
    expect(scopeLocked(d)).toBe(true);
    expect(storeLocked(d)).toBe(true);
  });

  it('packing names keys already in .env.local and asks for no values', () => {
    const d = packDraft(['QA_A', 'QA_B'], 'user');

    expect(d.vars.map((v) => v.envVar)).toEqual(['QA_A', 'QA_B']);
    expect(d.store).toBe('env');
    expect(asksValues(d)).toBe(false);
    expect(namesLocked(d) && scopeLocked(d) && storeLocked(d)).toBe(true);
  });

  it('editing keeps the credential and its scope; setting values edits nothing else', () => {
    const edit = editDraft(statusRow());
    const values = valuesDraft(statusRow());

    expect(edit.typeid).toBe('credential-1');
    expect(scopeLocked(edit)).toBe(true);
    expect(asksValues(edit)).toBe(false);
    expect(values.mode).toBe('values');
    expect(namesLocked(values)).toBe(true);
    expect(values.vars[0].description).toBe('secret key');
  });
});

describe('validateDraft', () => {
  it('a custom key needs a name, setup instructions and valid, unique variable names', () => {
    const d = customDraft('user');
    d.vars = [emptyVar('9BAD'), emptyVar('DUP'), emptyVar('DUP')];

    const p = validateDraft(d, new Set());

    expect(p.form).toEqual(['title-required', 'setup-required']);
    expect(Object.values(p.vars)).toEqual(['bad-env-var', 'duplicate']);
    expect(validateDraft({ ...d, title: 'Stripe', setup: 'From the dashboard.' }, new Set()).form).toEqual([]);
  });

  it('a save sends the setup instructions and keeps the setup wiki', () => {
    const d = { ...customDraft('user'), title: 'Stripe', setup: '  From the dashboard.  ', setupWiki: 'Stripe keys', vars: [emptyVar('STRIPE_KEY')] };

    const { manifest } = toSaveRequest(d, null);

    expect(manifest.setup).toBe('From the dashboard.');
    expect(manifest.setup_wiki).toBe('Stripe keys');
  });

  it('a variable another credential in the same scope declares is refused', () => {
    const d = { ...customDraft('project'), title: 'Mine', vars: [emptyVar('TAKEN')] };

    expect(Object.values(validateDraft(d, new Set(['TAKEN'])).vars)).toEqual(['taken']);
  });

  it('a template checks each value against its pattern, and requires required values', () => {
    const d = templateDraft(gmail(), 'user');
    d.vars[1].value = 'NOT-SIXTEEN';

    const p = validateDraft(d, new Set());

    expect(p.vars[d.vars[0].id]).toBe('required-value');
    expect(p.vars[d.vars[1].id]).toBe('pattern');
  });

  it('setting values accepts empty fields — they keep what is stored', () => {
    expect(validateDraft(valuesDraft(statusRow()), new Set(['STRIPE_KEY']))).toEqual({ form: [], vars: {} });
  });
});

describe('toSaveRequest', () => {
  it('carries what the credential is needed for, and the full reason', () => {
    const d = { ...customDraft('project'), title: 'Stripe', setup: 'x', neededFor: ' Charges cards. ', justification: ' pay.ts ' };
    d.vars = [emptyVar('STRIPE_KEY')];

    const { manifest } = toSaveRequest(d, 'p1');

    expect([manifest.needed_for, manifest.justification]).toEqual(['Charges cards.', 'pay.ts']);
  });

  it('a new credential names its scope and project, and only filled values travel', () => {
    const d = { ...customDraft('project'), title: 'My Stripe', description: ' Payments ', setup: 'From the Stripe dashboard.' };
    d.vars = [
      { ...emptyVar('STRIPE_KEY'), description: 'the secret key', value: 'sk_test' },
      { ...emptyVar('STRIPE_ACCOUNT'), secret: false },
    ];

    expect(toSaveRequest(d, 'p1')).toEqual({
      scope: 'project',
      project_id: 'p1',
      manifest: {
        name: 'my-stripe',
        title: 'My Stripe',
        description: 'Payments',
        icon_name: undefined,
        help_url: undefined,
        setup_wiki: undefined,
        setup: 'From the Stripe dashboard.',
        lm_provider: undefined,
        vars: {
          STRIPE_KEY: { label: undefined, hint: 'the secret key', placeholder: undefined, pattern: undefined, help_url: undefined, secret: true, required: 'MUST' },
          STRIPE_ACCOUNT: { label: undefined, hint: undefined, placeholder: undefined, pattern: undefined, help_url: undefined, secret: false, required: 'MUST' },
        },
      },
      values: { STRIPE_KEY: 'sk_test' },
      store: 'env',
    });
  });

  it('a user credential sends no project; a template keeps manifest fields the form does not edit', () => {
    const req = toSaveRequest(templateDraft(gmail(), 'user'), 'p1');

    expect(req.scope).toBe('user');
    expect(req.project_id).toBeNull();
    expect(req.manifest.name).toBe('gmail');
    expect(req.manifest.vars.GMAIL_ADDRESS.account_key).toBe(true);
  });

  it('an update names the credential, not a scope', () => {
    const req = toSaveRequest(editDraft(statusRow()), 'p1');

    expect(req.typeid).toBe('credential-1');
    expect(req.scope).toBeUndefined();
  });

  it('an edit keeps an either-or group and a cli variable\'s commands, and never sends a value for it', () => {
    const login = { commands: { darwin: 'gcloud auth application-default login' } };
    const check = { commands: { darwin: 'gcloud auth application-default print-access-token' } };
    const base = statusRow().vars[0];
    const google = statusRow({
      vars: [
        { ...base, env_var: 'GOOGLE_APPLICATION_CREDENTIALS', required: 'ONE_OF', kind: 'file' },
        { ...base, env_var: 'GCLOUD_ADC', required: 'ONE_OF', kind: 'cli', store: 'cli', found_in: null, login: login.commands.darwin, login_spec: login, check_spec: check },
        { ...base, env_var: 'GCP_REGION', required: 'OPTIONAL' },
      ],
    });

    const { vars } = toSaveRequest(editDraft(google), 'p1').manifest;
    expect(vars.GOOGLE_APPLICATION_CREDENTIALS).toMatchObject({ required: 'ONE_OF', kind: 'file' });
    expect(vars.GCLOUD_ADC).toMatchObject({ required: 'ONE_OF', kind: 'cli', login, check });
    expect(vars.GCP_REGION.required).toBe('OPTIONAL');

    // Set values: the cli variable shows its command, and whatever is in its slot is not written.
    const d = valuesDraft(google);
    expect(loginCommands(d.vars[1], google)).toEqual([login.commands.darwin]);
    d.vars[0].value = '{"type": "service_account"}';
    d.vars[1].value = 'stray';
    expect(validateDraft(d, new Set()).vars).toEqual({});
    expect(toSaveRequest(d, 'p1').values).toEqual({ GOOGLE_APPLICATION_CREDENTIALS: '{"type": "service_account"}' });
  });

  it('a template keeps ONE_OF, and does not demand a value from a group member or a cli variable', () => {
    const spec = new Credential({
      name: 'google-cloud',
      title: 'Google Cloud',
      scope: 'system',
      vars: {
        GOOGLE_APPLICATION_CREDENTIALS: { required: 'ONE_OF', kind: 'file' },
        GCLOUD_ADC: { required: 'ONE_OF', kind: 'cli', login: { commands: { darwin: 'gcloud auth application-default login', linux: 'gcloud auth application-default login' } } },
      },
    } as never);
    const d = templateDraft(spec, 'project');

    expect(loginCommands(d.vars[1])).toEqual(['gcloud auth application-default login']);
    expect(validateDraft(d, new Set()).vars).toEqual({});
    expect(Object.values(toSaveRequest(d, 'p1').manifest.vars).map((x) => x.required)).toEqual(['ONE_OF', 'ONE_OF']);
  });

  it('packing sends no values', () => {
    const d = { ...packDraft(['QA_A'], 'user'), title: 'QA pack' };

    expect(toSaveRequest(d, null).values).toEqual({});
  });
});

describe('names', () => {
  it('slugifies a title into a folder name and a label into an env var', () => {
    expect(slugify('My Stripe Key!')).toBe('my-stripe-key');
    expect(slugify('***')).toBe('credential');
    expect(toEnvVarName('open ai key')).toBe('OPEN_AI_KEY');
    expect(toEnvVarName('2fa code')).toBe('_2FA_CODE');
  });
});
