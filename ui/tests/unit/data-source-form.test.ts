/**
 * The create form's rules, over manifests rather than a hardcoded catalog.
 *
 * The interesting cases are the ones that used to be `if (provider === 'rss')`
 * branches: a feed URL that is not a URL, a Slack channel NAME where an ID
 * belongs. Both are now one `pattern` in the driver's Config schema, so this file proves the
 * generic check does what the two special cases did.
 */
import { describe, expect, it } from 'vitest';
import {
  accountKeyFor,
  buildConfig,
  choiceOf,
  emptyDraft,
  pickedFrom,
  validateDraft,
} from '@src/components/data-sources/source-form';

// One source = one stream: a feed is ONE url, a Slack source ONE channel.
const rss = {
  config: {
    feed_url: { type: 'text', label: 'Feed URL' },
  },
  config_schema: { required: ['feed_url'], properties: { feed_url: { pattern: '^https?://' } } },
} as never;

const slack = {
  config: {
    channel: { type: 'text', label: 'Channel' },
  },
  config_schema: { required: ['channel'], properties: { channel: { anyOf: [{ pattern: '^[CGD][A-Z0-9]{6,}$' }, {}] } } },
} as never;

// A multi-value field that is still a list — a Slack source's allowed senders.
const senders = {
  config: { allowed_senders: { type: 'lines', label: 'Allowed senders', account_key: true } },
  config_schema: { properties: { allowed_senders: { items: { pattern: '^U[A-Z0-9]{6,}$' } } } },
} as never;

const hn = {
  config: {
    types: { type: 'csv', label: 'Item types' },
    min_score: { type: 'number', label: 'Minimum score' },
  },
} as never;

const draft = (provider: string, fields: Record<string, string>, picked = {}) => ({
  ...emptyDraft(),
  provider,
  name: 'a source',
  fields,
  picked,
});

// The shape a picker fills for a stream-identity field: ONE value (`text`).
const pickable = {
  config: { channel: { type: 'text', choices: true } },
  config_schema: { required: ['channel'], properties: { channel: { anyOf: [{ pattern: '^[CGD][A-Z0-9]{6,}$' }, {}] } } },
} as never;
const bucket = {
  config: { bucket: { type: 'text', choices: true, account_key: true } },
  config_schema: { required: ['bucket'], properties: { bucket: {} } },
} as never;

describe('emptyDraft starts from the Config defaults', () => {
  it('prefills a field that declares a default and leaves the rest empty', () => {
    const waha = {
      name: 'waha',
      config: {
        base_url: { type: 'text', label: 'WAHA URL' },
        session: { type: 'text', label: 'Session' },
        types: { type: 'csv', label: 'Types' },
      },
      config_schema: {
        required: ['base_url'],
        properties: { base_url: {}, session: { default: 'default' }, types: { default: ['story', 'job'] } },
      },
    } as never;
    const draft = emptyDraft(waha);
    // A list default is joined the way an edited source's stored list is shown (csv → ", ").
    expect([draft.provider, draft.fields]).toEqual(['waha', { session: 'default', types: 'story, job' }]);
    expect(emptyDraft().fields).toEqual({});
  });
});

describe('buildConfig types values from the manifest', () => {
  it('splits lines and csv, coerces numbers, omits empties', () => {
    const config = buildConfig(draft('hackernews', { types: 'story, job', min_score: '25' }), hn);
    expect(config).toEqual({ types: ['story', 'job'], min_score: 25 });
  });
});

describe('validateDraft replaces the per-provider branches', () => {
  it('rejects a feed URL that is not a URL, naming the offender', () => {
    const problems = validateDraft(draft('rss', { feed_url: 'not-a-url' }), rss);
    expect(problems.join(' ')).toContain('not-a-url');
  });

  it('checks each entry of a list field, naming only the offender', () => {
    const problems = validateDraft(draft('slack', { allowed_senders: 'U0123456789\n#general' }), senders);
    expect(problems.join(' ')).toContain('#general');
    expect(problems.join(' ')).not.toContain('U0123456789');
  });

  it('rejects a Slack channel NAME where an ID belongs', () => {
    const problems = validateDraft(draft('slack', { channel: '#general' }), slack);
    expect(problems.join(' ')).toContain('#general');
  });

  it('accepts valid values', () => {
    expect(validateDraft(draft('slack', { channel: 'C0123456789' }), slack)).toEqual([]);
  });

  it('reports a missing required field once, not twice', () => {
    expect(validateDraft(draft('rss', {}), rss)).toEqual(['Feed URL is required.']);
  });
});

describe('accountKeyFor', () => {
  it('takes the FIRST value of a marked list field — appending must not rename', () => {
    expect(accountKeyFor(draft('slack', { allowed_senders: 'U0000001\nU0000002' }), senders)).toBe('U0000001');
  });

  it('is empty when no field names an account — the Slack case', () => {
    expect(accountKeyFor(draft('slack', { channel: 'C0123456789' }), slack)).toBe('');
  });
});

describe('a choosable field', () => {
  it('stores id AND name, so reopening the form reads "general" not "C0123"', () => {
    const picked = { channel: [{ id: 'C0123456789', name: 'general' }] };
    expect(buildConfig(draft('slack', {}, picked), pickable)).toEqual({
      channel: { id: 'C0123456789', name: 'general' },
    });
  });

  it('collapses an entry whose name adds nothing back to a bare string', () => {
    // A GCS bucket's name IS its id. Storing `{id, name}` there would grow a shape the
    // provider never had, for a label that repeats the value beside it.
    const picked = { bucket: [{ id: 'acme-docs', name: 'acme-docs' }] };
    expect(buildConfig(draft('gcs', {}, picked), bucket)).toEqual({ bucket: 'acme-docs' });
  });

  it('stores a single-value field as the value, never a one-item list', () => {
    const picked = { bucket: [{ id: 'acme-docs', name: 'Acme docs' }] };
    expect(buildConfig(draft('gcs', {}, picked), bucket)).toEqual({
      bucket: { id: 'acme-docs', name: 'Acme docs' },
    });
  });

  it('still honours typed text when nothing was picked — the fallback path', () => {
    expect(buildConfig(draft('slack', { channel: 'C0123456789' }, {}), pickable)).toEqual({
      channel: 'C0123456789',
    });
  });

  it('is satisfied by a pick alone, with no pattern check', () => {
    // The value came off a list the provider just returned; a regex here could only
    // reject something the provider says is real.
    expect(validateDraft(draft('slack', {}, { channel: [{ id: 'C1', name: 'general' }] }), pickable)).toEqual([]);
  });

  it('is still required when neither picked nor typed', () => {
    expect(validateDraft(draft('slack', {}, { channel: [] }), pickable)).toEqual(['channel is required.']);
  });

  it('still pattern-checks what was TYPED into it', () => {
    const problems = validateDraft(draft('slack', { channel: '#general' }, {}), pickable);
    expect(problems.join(' ')).toContain('#general');
  });

  it('names the account by the picked ID, never the display name', () => {
    // A renamed bucket or channel must not rename the source with it.
    const picked = { bucket: [{ id: 'acme-docs', name: 'Acme docs' }] };
    expect(accountKeyFor(draft('gcs', {}, picked), bucket)).toBe('acme-docs');
  });
});

describe('reading config back', () => {
  const field = { type: 'text', choices: true } as never;

  it('reads a bare id — every value stored before the picker existed', () => {
    expect(pickedFrom('channel', field, { channel: 'C0123456789' })).toEqual([
      { id: 'C0123456789', name: 'C0123456789' },
    ]);
  });

  it('reads what the picker wrote', () => {
    expect(pickedFrom('channel', field, { channel: { id: 'C1', name: 'general' } })).toEqual([
      { id: 'C1', name: 'general' },
    ]);
  });

  it('drops an entry with no id rather than rendering it', () => {
    // This is the `[object Object]` case: an unreadable entry used to be joined into the
    // input and then saved back verbatim, over the real ids.
    expect(pickedFrom('channel', field, { channel: { name: 'idless' } })).toEqual([]);
    expect(pickedFrom('channel', field, { channel: 42 })).toEqual([]);
    expect(choiceOf({ name: 'idless' })).toBeNull();
  });

  it('reads nothing for a field that is not choosable', () => {
    expect(pickedFrom('channel', { type: 'text' } as never, { channel: 'C1' })).toEqual([]);
  });
});

describe('the typed fallback', () => {
  it('carries IDs, because whatever sits in it is what the next keystroke saves', () => {
    // Editing a source while the provider cannot list drops the field back to a text box
    // seeded from config. If that box said "Marketing", typing in it would clear the picks
    // and store "Marketing" as a drive ID — a silently broken source. The friendly name
    // lives in the picker, which reads `picked`.
    const picked = pickedFrom('drive', { type: 'text', choices: true } as never, {
      drive: { id: '0ABxyz', name: 'Marketing' },
    });
    expect(picked).toEqual([{ id: '0ABxyz', name: 'Marketing' }]);
  });

  it('round-trips those ids back to the same config when typed', () => {
    // The fallback path: no picks, the ids typed as text, stored exactly as before.
    const typed = draft('gdrive', { drive: '0ABxyz' }, {});
    const spec = { config: { drive: { type: 'text', choices: true } } } as never;
    expect(buildConfig(typed, spec)).toEqual({ drive: '0ABxyz' });
  });
});
