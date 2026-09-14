/**
 * The one credential form's rules. Every entry point — a Custom API key, a
 * catalogue template, packed `.env.local` keys, the quick-create Secret tile —
 * builds one of these drafts and saves it the same way.
 */
import { describe, expect, it } from 'vitest';
import { CredentialSpec, type CredentialStatusRow } from '@sdk';
import {
  asksValues,
  customDraft,
  editDraft,
  emptyVar,
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
  new CredentialSpec({
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
  new CredentialSpec({
    name: 'openrouter',
    title: 'OpenRouter',
    scope: 'system',
    lm_provider: 'openrouter',
    value_store: 'vault',
    vars: { OPENROUTER_API_KEY: { label: 'API key' } },
  } as never);

const statusRow = (over: Partial<CredentialStatusRow> = {}): CredentialStatusRow => ({
  typeid: 'credential_spec-1',
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
    { env_var: 'STRIPE_KEY', label: '', hint: 'secret key', placeholder: '', pattern: '', help_url: '', secret: true, required: true, present: true, found_in: 'vault', warning: null, shadowed_by: null },
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

    expect(edit.typeid).toBe('credential_spec-1');
    expect(scopeLocked(edit)).toBe(true);
    expect(asksValues(edit)).toBe(false);
    expect(values.mode).toBe('values');
    expect(namesLocked(values)).toBe(true);
    expect(values.vars[0].description).toBe('secret key');
  });
});

describe('validateDraft', () => {
  it('a custom key needs a name and valid, unique variable names', () => {
    const d = customDraft('user');
    d.vars = [emptyVar('9BAD'), emptyVar('DUP'), emptyVar('DUP')];

    const p = validateDraft(d, new Set());

    expect(p.form).toEqual(['title-required']);
    expect(Object.values(p.vars)).toEqual(['bad-env-var', 'duplicate']);
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
  it('a new credential names its scope and project, and only filled values travel', () => {
    const d = { ...customDraft('project'), title: 'My Stripe', description: ' Payments ' };
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
        value_store: 'env',
        lm_provider: undefined,
        vars: {
          STRIPE_KEY: { label: undefined, hint: 'the secret key', placeholder: undefined, pattern: undefined, help_url: undefined, secret: true, required: true },
          STRIPE_ACCOUNT: { label: undefined, hint: undefined, placeholder: undefined, pattern: undefined, help_url: undefined, secret: false, required: true },
        },
      },
      values: { STRIPE_KEY: 'sk_test' },
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

    expect(req.typeid).toBe('credential_spec-1');
    expect(req.scope).toBeUndefined();
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
