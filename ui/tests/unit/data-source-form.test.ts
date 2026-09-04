/**
 * The create form's rules, over manifests rather than a hardcoded catalog.
 *
 * The interesting cases are the ones that used to be `if (provider === 'rss')`
 * branches: a feed URL that is not a URL, a Slack channel NAME where an ID
 * belongs. Both are now one `pattern` on the field, so this file proves the
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

const rss = {
  config: {
    feed_urls: { type: 'lines', required: true, label: 'Feed URLs', pattern: '^https?://' },
  },
} as never;

const slack = {
  config: {
    channels: { type: 'lines', required: true, label: 'Channel IDs', pattern: '^[CGD][A-Z0-9]{6,}$' },
  },
} as never;

const hn = {
  config: {
    types: { type: 'csv', label: 'Item types' },
    min_score: { type: 'number', label: 'Minimum score' },
  },
} as never;

const draft = (provider: string, fields: Record<string, string>, picked = {}) => ({
  ...emptyDraft(provider),
  name: 'a source',
  fields,
  picked,
});

// The two shapes a picker fills: many (`lines`) and one (`text`).
const pickable = {
  config: { channels: { type: 'lines', required: true, choices: true, pattern: '^[CGD][A-Z0-9]{6,}$' } },
} as never;
const bucket = {
  config: { bucket: { type: 'text', required: true, choices: true, account_key: true } },
} as never;

describe('buildConfig types values from the manifest', () => {
  it('splits lines and csv, coerces numbers, omits empties', () => {
    const config = buildConfig(draft('hackernews', { types: 'story, job', min_score: '25' }), hn);
    expect(config).toEqual({ types: ['story', 'job'], min_score: 25 });
  });
});

describe('validateDraft replaces the per-provider branches', () => {
  it('rejects a feed URL that is not a URL, naming the offender', () => {
    const problems = validateDraft(draft('rss', { feed_urls: 'https://ok.dev/f.xml\nnot-a-url' }), rss);
    expect(problems.join(' ')).toContain('not-a-url');
  });

  it('rejects a Slack channel NAME where an ID belongs', () => {
    const problems = validateDraft(draft('slack', { channels: '#general' }), slack);
    expect(problems.join(' ')).toContain('#general');
  });

  it('accepts valid values', () => {
    expect(validateDraft(draft('slack', { channels: 'C0123456789' }), slack)).toEqual([]);
  });

  it('reports a missing required field once, not twice', () => {
    expect(validateDraft(draft('rss', {}), rss)).toEqual(['Feed URLs is required.']);
  });
});

describe('accountKeyFor', () => {
  it('takes the FIRST value of the marked field — appending must not rename', () => {
    const spec = {
      config: { feed_urls: { type: 'lines', account_key: true } },
    } as never;
    expect(accountKeyFor(draft('rss', { feed_urls: 'https://a.dev\nhttps://b.dev' }), spec)).toBe('https://a.dev');
  });

  it('is empty when no field names an account — the Slack case', () => {
    expect(accountKeyFor(draft('slack', { channels: 'C0123456789' }), slack)).toBe('');
  });
});

describe('a choosable field', () => {
  it('stores id AND name, so reopening the form reads "general" not "C0123"', () => {
    const picked = { channels: [{ id: 'C0123456789', name: 'general' }] };
    expect(buildConfig(draft('slack', {}, picked), pickable)).toEqual({
      channels: [{ id: 'C0123456789', name: 'general' }],
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
    expect(buildConfig(draft('slack', { channels: 'C0123456789' }, {}), pickable)).toEqual({
      channels: ['C0123456789'],
    });
  });

  it('is satisfied by a pick alone, with no pattern check', () => {
    // The value came off a list the provider just returned; a regex here could only
    // reject something the provider says is real.
    expect(validateDraft(draft('slack', {}, { channels: [{ id: 'C1', name: 'general' }] }), pickable)).toEqual([]);
  });

  it('is still required when neither picked nor typed', () => {
    expect(validateDraft(draft('slack', {}, { channels: [] }), pickable)).toEqual(['channels is required.']);
  });

  it('still pattern-checks what was TYPED into it', () => {
    const problems = validateDraft(draft('slack', { channels: '#general' }, {}), pickable);
    expect(problems.join(' ')).toContain('#general');
  });

  it('names the account by the picked ID, never the display name', () => {
    // A renamed bucket or channel must not rename the source with it.
    const picked = { bucket: [{ id: 'acme-docs', name: 'Acme docs' }] };
    expect(accountKeyFor(draft('gcs', {}, picked), bucket)).toBe('acme-docs');
  });
});

describe('reading config back', () => {
  const field = { type: 'lines', choices: true } as never;

  it('reads a bare id — every value stored before the picker existed', () => {
    expect(pickedFrom('channels', field, { channels: ['C0123456789'] })).toEqual([
      { id: 'C0123456789', name: 'C0123456789' },
    ]);
  });

  it('reads what the picker wrote', () => {
    expect(pickedFrom('channels', field, { channels: [{ id: 'C1', name: 'general' }] })).toEqual([
      { id: 'C1', name: 'general' },
    ]);
  });

  it('drops an entry with no id rather than rendering it', () => {
    // This is the `[object Object]` case: an unreadable entry used to be joined into the
    // input and then saved back verbatim, over the real ids.
    expect(pickedFrom('channels', field, { channels: [{ name: 'idless' }, 42] })).toEqual([]);
    expect(choiceOf({ name: 'idless' })).toBeNull();
  });

  it('reads nothing for a field that is not choosable', () => {
    expect(pickedFrom('channels', { type: 'lines' } as never, { channels: ['C1'] })).toEqual([]);
  });
});

describe('the typed fallback', () => {
  it('carries IDs, because whatever sits in it is what the next keystroke saves', () => {
    // Editing a source while the provider cannot list drops the field back to a text box
    // seeded from config. If that box said "Marketing", typing in it would clear the picks
    // and store "Marketing" as a drive ID — a silently broken source. The friendly name
    // lives in the picker, which reads `picked`.
    const picked = pickedFrom('drives', { type: 'lines', choices: true } as never, {
      drives: [{ id: '0ABxyz', name: 'Marketing' }, { id: '0ABabc', name: 'Legal' }],
    });
    expect(picked.map((c) => c.id)).toEqual(['0ABxyz', '0ABabc']);
    expect(picked.map((c) => c.name)).toEqual(['Marketing', 'Legal']);
  });

  it('round-trips those ids back to the same config when typed', () => {
    // The fallback path: no picks, the ids typed as text, stored exactly as before.
    const typed = draft('gdrive', { drives: '0ABxyz\n0ABabc' }, {});
    const spec = { config: { drives: { type: 'lines', choices: true } } } as never;
    expect(buildConfig(typed, spec)).toEqual({ drives: ['0ABxyz', '0ABabc'] });
  });
});
