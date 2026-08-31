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
  emptyDraft,
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

const draft = (provider: string, fields: Record<string, string>) => ({
  ...emptyDraft(provider),
  name: 'a source',
  fields,
});

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
