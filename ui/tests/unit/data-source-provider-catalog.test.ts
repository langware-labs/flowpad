/**
 * The add-source form's rules, where the traps live.
 *
 * Every assertion here corresponds to a way a source can be created that LOOKS
 * configured and then silently does the wrong thing: an interval the backend
 * will 422, a feed list that yields no streams, an agent connector that forks
 * every thread in a mailbox, a `kind` the sync loop will overwrite anyway.
 */
import { describe, expect, it } from 'vitest';
import {
  accountKeyFor,
  buildConfig,
  emptyDraft,
  MIN_POLL_INTERVAL_SECONDS,
  PROVIDERS,
  setupWiki,
  validateDraft,
  type SourceDraft,
} from '@src/components/data-sources/provider-catalog';

const draft = (over: Partial<SourceDraft> = {}): SourceDraft => ({
  ...emptyDraft(over.provider ?? 'rss'),
  name: 'A source',
  ...over,
});

describe('provider catalog', () => {
  it('covers exactly the registered drivers', () => {
    // flow_sdk/ingest/drivers/__init__.py registers these and nothing else.
    // There is no endpoint listing them, so this list IS the contract.
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual([
      'agent',
      'agentmail',
      'hackernews',
      'rss',
      'slack',
    ]);
  });

  it('offers a setup wiki page only where the driver actually verifies', () => {
    // Offering "how to finish setup" for a provider with no setup step sends
    // the user looking for work that does not exist.
    expect(setupWiki('slack')).toBe('Slack channels');
    expect(setupWiki('SLACK')).toBe('Slack channels');
    expect(setupWiki('rss')).toBeUndefined();
    expect(setupWiki('')).toBeUndefined();
  });
});

describe('validation — slack', () => {
  const slack = (channels: string) =>
    validateDraft(draft({ provider: 'slack', fields: { channels } })).join(' ');

  it('accepts channel IDs', () => {
    expect(slack('C0123456789\nG0987654321')).toBe('');
  });

  it('rejects a channel NAME, which would fail as `channel_not_found`', () => {
    // Not a near miss: `streams()` keys on whatever it is given, so the source
    // would poll a channel that does not exist while looking configured.
    expect(slack('#engineering')).toMatch(/Use the ID/);
    expect(slack('engineering')).toMatch(/Not Slack channel IDs/);
  });

  it('requires at least one channel', () => {
    // Zero channels is not an empty source, it is one that can never poll:
    // `streams()` returns nothing, so no cursor is ever created.
    expect(slack('')).toMatch(/required/i);
  });

  it('does not name the workspace from a channel', () => {
    // `account_key` describes the remote ACCOUNT, and the workspace lives on
    // the OAuth connection — the form never sees it.
    expect(accountKeyFor(draft({ provider: 'slack', fields: { channels: 'C0123456789' } }))).toBe('');
  });
});

describe('validation — sync policy', () => {
  it('refuses an interval below the heartbeat', () => {
    const problems = validateDraft(draft({ poll_interval_seconds: MIN_POLL_INTERVAL_SECONDS - 1,
      fields: { feed_urls: 'https://a.test/feed' } }));
    expect(problems.join(' ')).toMatch(/at least 60s/);
  });

  it('accepts exactly the minimum', () => {
    expect(
      validateDraft(draft({ poll_interval_seconds: MIN_POLL_INTERVAL_SECONDS,
        fields: { feed_urls: 'https://a.test/feed' } })),
    ).toEqual([]);
  });

  it('refuses a zero-day window', () => {
    expect(
      validateDraft(draft({ window_days: 0, fields: { feed_urls: 'https://a.test/feed' } })).join(' '),
    ).toMatch(/at least 1 day/);
  });
});

describe('validation — per driver', () => {
  it('rss needs at least one feed URL, and each must be http(s)', () => {
    expect(validateDraft(draft({ fields: { feed_urls: '' } })).join(' ')).toMatch(/Feed URLs is required/);
    expect(validateDraft(draft({ fields: { feed_urls: 'not a url' } })).join(' ')).toMatch(/full http\(s\) URL/);
    expect(validateDraft(draft({ fields: { feed_urls: 'https://a.test/f\nhttps://b.test/f' } }))).toEqual([]);
  });

  it('agent needs a connector — an empty one forks every thread, permanently', () => {
    const problems = validateDraft(
      draft({ provider: 'agent', fields: { connector: '', harness: 'claude' } }),
    );
    expect(problems.join(' ')).toMatch(/Connector is required/);
  });

  it('agent needs a harness — without one the source parks on config_error', () => {
    expect(
      validateDraft(draft({ provider: 'agent', fields: { connector: 'gmail', harness: '' } })).join(' '),
    ).toMatch(/Harness is required/);
  });

  it('agentmail needs both inbox and api key', () => {
    const problems = validateDraft(draft({ provider: 'agentmail', fields: {} }));
    expect(problems.join(' ')).toMatch(/Inbox is required/);
    expect(problems.join(' ')).toMatch(/API key is required/);
  });

  it('hackernews needs nothing — every field has a driver default', () => {
    expect(validateDraft(draft({ provider: 'hackernews', fields: {} }))).toEqual([]);
  });
});

describe('validation — duplicates are allowed', () => {
  it('does not block a second source on the same account', () => {
    // Ids are uuid4 and each row is its own thing. Whether a second poller on
    // one account is worth its request cost is the operator's call, not this
    // form's — there is deliberately no uniqueness gate here or on the backend.
    expect(validateDraft(draft({ fields: { feed_urls: 'https://a.test/f' } }))).toEqual([]);
  });
});

describe('buildConfig', () => {
  it('splits a feed list into one entry per line', () => {
    const config = buildConfig(draft({ fields: { feed_urls: 'https://a.test/f\n\n https://b.test/f ' } }));
    expect(config).toEqual({ feed_urls: ['https://a.test/f', 'https://b.test/f'] });
  });

  it('omits empty optionals rather than writing them as empty strings', () => {
    // Every optional key has a real default inside the driver; "" is not
    // absent, it would override that default with nothing.
    const config = buildConfig(draft({ provider: 'hackernews', fields: { types: '', min_score: '', base_url: '' } }));
    expect(config).toEqual({});
  });

  it('types numbers and splits csv fields', () => {
    const config = buildConfig(
      draft({ provider: 'hackernews', fields: { types: 'story, job', min_score: '25' } }),
    );
    expect(config).toEqual({ types: ['story', 'job'], min_score: 25 });
  });

  it('never writes kind or channel — sync_source owns both', () => {
    // Setting either from the form produces a value that looks authoritative,
    // is owned by nobody, and gets silently corrected on the first poll.
    for (const provider of PROVIDERS.map((p) => p.id)) {
      const config = buildConfig(draft({ provider, fields: { connector: 'gmail' } }));
      expect(Object.keys(config)).not.toContain('kind');
      expect(Object.keys(config)).not.toContain('channel');
    }
  });
});

describe('accountKeyFor', () => {
  it('derives the account from the field that owns it', () => {
    expect(accountKeyFor(draft({ provider: 'agentmail', fields: { inbox: 'me@agentmail.to' } })))
      .toBe('me@agentmail.to');
    expect(accountKeyFor(draft({ provider: 'agent', fields: { connector: 'gmail' } }))).toBe('gmail');
  });

  it('prefers an explicit account key', () => {
    expect(
      accountKeyFor(draft({ provider: 'agentmail', account_key: 'chosen', fields: { inbox: 'me@x.to' } })),
    ).toBe('chosen');
  });

  it('falls back to the provider default', () => {
    expect(accountKeyFor(draft({ provider: 'hackernews', fields: {} }))).toBe('public');
  });

  it('takes the FIRST entry of a multi-value field', () => {
    // Descriptive identity, so it must not drift: using the whole textarea
    // would change the account every time a URL was appended to the list.
    expect(
      accountKeyFor(draft({ fields: { feed_urls: 'https://a.test/f\nhttps://b.test/f' } })),
    ).toBe('https://a.test/f');
  });


});
