import { t } from '@lingui/core/macro';
import { FieldType, type DataSourceSpec, type SpecConfigField } from '@sdk';

/**
 * The create form's logic, over a manifest the BACKEND supplies.
 *
 * This file used to be `provider-catalog.ts` and hardcoded every provider's
 * fields as literal strings, because the driver registry had no list accessor
 * and no route. It does now: a source is a `data_source_spec` asset, so the
 * form reads `config_schema` and a new source lights the dialog up with no
 * frontend release.
 *
 * **Pure — no React, no SDK calls.** Specs arrive as arguments rather than a
 * module constant, so every rule below is testable without rendering anything
 * or standing up a backend.
 *
 * The per-provider validators are gone with the catalog. `isHttpUrl` for RSS
 * and a Slack channel-id regex used to live here as `if (provider === …)`
 * branches; both are now a `pattern` on the field, which is the same check
 * expressed once instead of once per provider.
 */

/** Mirror of `MIN_POLL_INTERVAL_SECONDS` (flow_sdk/builtin/data_source.py),
 *  enforced there by `APIField(ge=60)`. Duplicated only to turn a 422 into a
 *  sentence the user can act on. */
export const MIN_POLL_INTERVAL_SECONDS = 60;

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

/** `[key, field]` pairs in declaration order — the order the form renders. */
export function specFields(spec?: DataSourceSpec): [string, SpecConfigField][] {
  return Object.entries(spec?.config_schema ?? {});
}

export function emptyDraft(provider: string): SourceDraft {
  return {
    name: '',
    provider,
    // Empty means "derive from the fields" — `accountKeyFor` owns the default,
    // so exactly one place knows it.
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

/** Compiled patterns, keyed by the pattern itself. `validateDraft` re-runs on
 *  every keystroke, and a manifest's patterns are immutable, so compiling per
 *  call was pure waste. */
const PATTERNS = new Map<string, RegExp>();

function patternFor(pattern: string): RegExp {
  let re = PATTERNS.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    PATTERNS.set(pattern, re);
  }
  return re;
}

/**
 * The driver-specific half of the entity.
 *
 * Empty values are OMITTED rather than written as `""`/`null`: every optional
 * key has a real default inside the driver, and an empty string is not absent —
 * it would override the default with nothing.
 *
 * `kind` and `channel` are deliberately absent from everything this produces.
 * `sync_source` writes both from the driver on the first poll, so a form-set
 * value is authoritative-looking, owned by nobody, and silently corrected later.
 */
export function buildConfig(draft: SourceDraft, spec?: DataSourceSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [key, field] of specFields(spec)) {
    const raw = (draft.fields[key] ?? '').trim();
    if (!raw) continue;
    if (field.type === FieldType.LINES) config[key] = splitLines(raw);
    else if (field.type === FieldType.CSV) config[key] = splitCsv(raw);
    else if (field.type === FieldType.NUMBER) {
      const n = Number(raw);
      if (!Number.isNaN(n)) config[key] = n;
    } else config[key] = raw;
  }
  return config;
}

/**
 * The account this draft names. An explicit entry always wins.
 *
 * Descriptive only: ids are uuid4 and nothing dedupes on this, so a wrong one
 * is a plain edit. A spec with no `account_key` field has no account to name —
 * Slack's case, where the workspace belongs to the connection, not the form.
 */
export function accountKeyFor(draft: SourceDraft, spec?: DataSourceSpec): string {
  const explicit = draft.account_key.trim();
  if (explicit) return explicit;
  const named = specFields(spec).find(([, f]) => f.account_key);
  if (!named) return '';
  const raw = (draft.fields[named[0]] ?? '').trim();
  // A multi-value field names the account by its FIRST value: appending a feed
  // must not silently rename the source.
  return named[1].type === FieldType.LINES ? (splitLines(raw)[0] ?? '') : raw;
}

/**
 * Everything wrong with this draft, in the order a person would fix it.
 *
 * Deliberately NOT a uniqueness check. Ids are uuid4, two sources may point at
 * the same account, and that is allowed — the cost of a second poller is the
 * operator's call, not this form's.
 */
export function validateDraft(draft: SourceDraft, spec?: DataSourceSpec): string[] {
  const problems: string[] = [];

  if (!draft.name.trim()) problems.push('Name is required.');
  if (!spec) problems.push(t`Unknown provider ${draft.provider}.`);

  for (const [key, field] of specFields(spec)) {
    const raw = (draft.fields[key] ?? '').trim();
    const label = field.label || key;
    if (field.required && !raw) {
      problems.push(t`${label} is required.`);
      continue;
    }
    if (!raw || !field.pattern) continue;
    // One regex, applied per value, so a multi-line field reports the exact
    // entries at fault rather than "something is wrong".
    const re = patternFor(field.pattern);
    const values =
      field.type === FieldType.LINES ? splitLines(raw) : field.type === FieldType.CSV ? splitCsv(raw) : [raw];
    const bad = values.filter((v) => !re.test(v));
    if (bad.length) problems.push(`${label}: not valid — ${bad.join(', ')}`);
  }

  if (draft.poll_interval_seconds < MIN_POLL_INTERVAL_SECONDS) {
    problems.push(
      `Poll interval must be at least ${MIN_POLL_INTERVAL_SECONDS}s — the heartbeat only ticks once a minute.`,
    );
  }
  if (draft.window_days < 1) problems.push('Window must be at least 1 day.');

  return problems;
}
