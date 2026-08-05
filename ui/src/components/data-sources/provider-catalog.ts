/**
 * The ingest drivers, as a form.
 *
 * **Hardcoded, deliberately.** The driver registry
 * (`flow_sdk/ingest/driver.py`) has `register_driver`/`get_driver` and no list
 * accessor, and no route exposes it. An endpoint would publish four literal
 * strings while the thing the form actually needs — each driver's config
 * schema — still lives nowhere on the backend. Same call the repo already makes
 * in `assets/editor/agent-profile/agent-vocabularies.ts` and `WORKER_TYPES`.
 * Revisit when the driver protocol grows a `config_schema`.
 *
 * **Pure — no React, no SDK.** Everything here is a value or a function over
 * values, so the validation rules (which is where the traps live) are unit
 * testable without rendering anything.
 */

/** Mirror of `MIN_POLL_INTERVAL_SECONDS` (flow_sdk/builtin/data_source.py:32),
 *  enforced there by `APIField(ge=60)`. The heartbeat ticks once a minute, so a
 *  smaller interval cannot mean anything. Duplicated here only to turn a 422
 *  into a sentence the user can act on. */
export const MIN_POLL_INTERVAL_SECONDS = 60;

export type FieldKind = 'text' | 'password' | 'number' | 'lines' | 'csv';

export interface ProviderField {
  /** Key inside `config`. */
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  placeholder?: string;
  /** Shown under the input. Use it for the consequence, not the syntax. */
  hint?: string;
  /** Collapsed behind "Advanced" — has a working default in the driver. */
  advanced?: boolean;
}

export interface ProviderSpec {
  id: string;
  label: string;
  blurb: string;
  fields: ProviderField[];
  /** The remote account this source names, derived from the entered fields.
   *  Descriptive only — `account_key` is the source's remote identity, not a
   *  key anything is deduped on. */
  accountKey: (fields: Record<string, string>) => string;
}

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: 'rss',
    label: 'RSS / Atom',
    blurb: 'One stream per feed URL. No credentials — the simplest source there is.',
    // The FIRST feed URL, not the whole list: appending a feed must not silently
    // rename the account. NOT a uniqueness key — ids are uuid4 and two sources
    // on one feed are allowed, so this only has to be descriptive.
    accountKey: (f) => splitLines(f.feed_urls ?? '')[0] ?? '',
    fields: [
      {
        key: 'feed_urls',
        label: 'Feed URLs',
        kind: 'lines',
        required: true,
        placeholder: 'https://example.com/feed.xml',
        hint: 'One per line. Each URL becomes its own stream with its own cursor and health.',
      },
    ],
  },
  {
    id: 'hackernews',
    label: 'Hacker News',
    blurb: 'The public firehose, filtered. No credentials.',
    accountKey: () => 'public',
    fields: [
      {
        key: 'types',
        label: 'Item types',
        kind: 'csv',
        placeholder: 'story',
        hint: 'Comma separated: story, comment, job, poll. Defaults to story.',
      },
      { key: 'min_score', label: 'Minimum score', kind: 'number', placeholder: '0' },
      { key: 'base_url', label: 'API base URL', kind: 'text', advanced: true },
    ],
  },
  {
    id: 'agent',
    label: 'Agent transport',
    blurb: 'Reaches a channel through a local agent harness — how Gmail is read today.',
    accountKey: (f) => (f.connector ?? '').trim(),
    fields: [
      {
        key: 'connector',
        label: 'Connector',
        kind: 'text',
        required: true,
        placeholder: 'gmail',
        hint: 'This is the CHANNEL, and half of every thread key. Leaving it empty forks every thread in the mailbox — permanently.',
      },
      {
        key: 'harness',
        label: 'Harness',
        kind: 'text',
        required: true,
        placeholder: 'claude',
        hint: 'The worker CLI that runs the fetch. Without a launchable one the source parks on config_error.',
      },
      { key: 'streams', label: 'Streams', kind: 'csv', placeholder: 'INBOX' },
      { key: 'agent', label: 'Agent', kind: 'text', advanced: true },
      { key: 'subagent', label: 'Subagent', kind: 'text', advanced: true },
      { key: 'max_items', label: 'Max items per run', kind: 'number', advanced: true },
    ],
  },
  {
    id: 'slack',
    label: 'Slack',
    blurb:
      'Channels in a connected Slack workspace. Connect Slack first, then invite the bot to each channel and press Verify.',
    // The workspace is a property of the CONNECTION, not of this form — the
    // OAuth token names it and the form never sees it. Left blank rather than
    // filled with a channel id, which would describe the wrong thing.
    accountKey: () => '',
    fields: [
      {
        key: 'channels',
        label: 'Channel IDs',
        kind: 'lines',
        required: true,
        placeholder: 'C0123456789',
        hint:
          'One per line, and the ID — not the name. Slack: open the channel → its name → the ID is at the bottom. A renamed channel keeps its ID; keying on the name would fork its history.',
      },
    ],
  },
  {
    id: 'agentmail',
    label: 'AgentMail',
    blurb: 'A hosted mailbox over its HTTP API.',
    accountKey: (f) => (f.inbox ?? '').trim(),
    fields: [
      {
        key: 'inbox',
        label: 'Inbox',
        kind: 'text',
        required: true,
        placeholder: 'you@agentmail.to',
      },
      {
        key: 'api_key',
        label: 'API key',
        kind: 'password',
        required: true,
        placeholder: 'am_…',
        hint: 'Stored in this source’s config on this machine, including its metadata shadow on disk.',
      },
      { key: 'base_url', label: 'API base URL', kind: 'text', advanced: true },
    ],
  },
];

export function providerSpec(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Wiki pages for the setup step a provider cannot do for you.
 *
 * A map rather than a field on `ProviderSpec` because it answers a different
 * question — not "what does this form ask for" but "what does the user have to
 * go do in another application". Only providers whose driver has a `verify`
 * step belong here; anything else would offer help for a step that does not
 * exist.
 */
const SETUP_WIKI: Record<string, string> = {
  slack: 'Slack channels',
};

/** The wiki page explaining this provider's setup step, or undefined. */
export function setupWiki(provider: string): string | undefined {
  return SETUP_WIKI[(provider || '').trim().toLowerCase()];
}

/** Slack channel IDs: C (public), G (private), D (DM). Names are not IDs. */
const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;

export interface SourceDraft {
  name: string;
  provider: string;
  account_key: string;
  enabled: boolean;
  poll_interval_seconds: number;
  window_days: number;
  /** Raw strings straight off the inputs; `buildConfig` types them. */
  fields: Record<string, string>;
}

export function emptyDraft(provider = 'rss'): SourceDraft {
  return {
    name: '',
    provider,
    // Empty means "derive from the fields" — `accountKeyFor` owns the default,
    // so there is exactly one place that knows it.
    account_key: '',
    enabled: true,
    poll_interval_seconds: 300,
    window_days: 7,
    fields: {},
  };
}

const splitLines = (raw: string): string[] =>
  raw.split('\n').map((s) => s.trim()).filter(Boolean);

const splitCsv = (raw: string): string[] =>
  raw.split(',').map((s) => s.trim()).filter(Boolean);

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The driver-specific half of the entity.
 *
 * Empty values are OMITTED rather than written as `""`/`null`: every optional
 * key here has a real default inside the driver, and an empty string is not
 * absent — it would override the default with nothing.
 *
 * `kind` and `channel` are deliberately absent from everything this module
 * produces. `sync_source` (flow_sdk/ingest/sync.py:67-75) writes both from the
 * driver on the first poll, so a form-set value is authoritative-looking, owned
 * by nobody, and silently corrected later.
 */
export function buildConfig(draft: SourceDraft): Record<string, unknown> {
  const spec = providerSpec(draft.provider);
  const config: Record<string, unknown> = {};
  if (!spec) return config;

  for (const field of spec.fields) {
    const raw = (draft.fields[field.key] ?? '').trim();
    if (!raw) continue;
    if (field.kind === 'lines') config[field.key] = splitLines(raw);
    else if (field.kind === 'csv') config[field.key] = splitCsv(raw);
    else if (field.kind === 'number') {
      const n = Number(raw);
      if (!Number.isNaN(n)) config[field.key] = n;
    } else config[field.key] = raw;
  }
  return config;
}

/** The account this draft names. An explicit entry always wins. */
export function accountKeyFor(draft: SourceDraft): string {
  return draft.account_key.trim() || providerSpec(draft.provider)?.accountKey(draft.fields) || '';
}

/**
 * Everything wrong with this draft, in the order a person would fix it.
 *
 * Deliberately NOT a uniqueness check. Ids are uuid4, two sources may point at
 * the same account, and that is allowed — the cost of a second poller is the
 * operator's call to make, not this form's.
 */
export function validateDraft(draft: SourceDraft): string[] {
  const problems: string[] = [];
  const spec = providerSpec(draft.provider);

  if (!draft.name.trim()) problems.push('Name is required.');
  if (!spec) problems.push(`Unknown provider ${draft.provider}.`);

  for (const field of spec?.fields ?? []) {
    const raw = (draft.fields[field.key] ?? '').trim();
    if (field.required && !raw) problems.push(`${field.label} is required.`);
  }

  if (draft.provider === 'rss') {
    const urls = splitLines(draft.fields.feed_urls ?? '');
    // Zero URLs is not an empty source, it is a source that can never poll:
    // `streams()` returns nothing, so no cursor is ever created.
    if (urls.length && urls.some((u) => !isHttpUrl(u))) {
      problems.push('Every feed URL must be a full http(s) URL.');
    }
  }

  if (draft.provider === 'slack') {
    // A `#name` here is not a near miss — `streams()` keys on whatever it is
    // given, so the source would poll a channel that does not exist and report
    // `channel_not_found` from a Verify that looked correctly configured.
    const bad = splitLines(draft.fields.channels ?? '').filter((c) => !SLACK_CHANNEL_ID.test(c));
    if (bad.length) {
      problems.push(`Not Slack channel IDs: ${bad.join(', ')}. Use the ID (C…), not the name.`);
    }
  }

  if (draft.poll_interval_seconds < MIN_POLL_INTERVAL_SECONDS) {
    problems.push(
      `Poll interval must be at least ${MIN_POLL_INTERVAL_SECONDS}s — the heartbeat only ticks once a minute.`,
    );
  }
  if (draft.window_days < 1) problems.push('Window must be at least 1 day.');

  return problems;
}
