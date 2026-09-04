import { t } from '@lingui/core/macro';
import { FieldType, type DataSourceChoice, type DataSourceSpec, type SpecConfigField } from '@sdk';

/**
 * The create form's logic, over a manifest the BACKEND supplies.
 *
 * This file used to be `provider-catalog.ts` and hardcoded every provider's
 * fields as literal strings, because the driver registry had no list accessor
 * and no route. It does now: a source is a `data_source_spec` asset, so the
 * form reads the spec's `config` and a new source lights the dialog up with no
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
  /**
   * What was PICKED, for the fields a manifest marks `choices`. A second map rather than
   * a richer `fields` value: a picked entry is `{id, name}`, and smuggling an object
   * through the string bag is exactly what makes `fieldValue` render `[object Object]`.
   * Empty for a field the user typed into instead — which is what makes the fallback work
   * with no mode flag anywhere in this file.
   */
  picked: Record<string, DataSourceChoice[]>;
}

/** `[key, field]` pairs in declaration order — the order the form renders. */
export function specFields(spec?: DataSourceSpec): [string, SpecConfigField][] {
  return Object.entries(spec?.config ?? {});
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
    picked: {},
  };
}

/**
 * One stored config entry, read as a choice.
 *
 * A bare string is `{id, name}` with both halves equal — that is a bucket, whose name IS
 * its id, and it is also every value stored before the picker existed. Anything else that
 * carries an `id` is what the picker writes. Returns null for a shape this form does not
 * model, so a caller drops it rather than rendering `[object Object]` and saving it back.
 */
export function choiceOf(raw: unknown): DataSourceChoice | null {
  if (typeof raw === 'string') return raw.trim() ? { id: raw.trim(), name: raw.trim() } : null;
  if (raw && typeof raw === 'object' && 'id' in raw) {
    const entry = raw as { id?: unknown; name?: unknown };
    const id = String(entry.id ?? '').trim();
    return id ? { id, name: String(entry.name ?? '') || id } : null;
  }
  return null;
}

/** A field's stored value as choices — one entry for a `text` field, many for `lines`. */
export function pickedFrom(
  key: string,
  field: SpecConfigField,
  config: Record<string, unknown>,
): DataSourceChoice[] {
  if (!field.choices) return [];
  const raw = config?.[key];
  const entries = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return entries.map(choiceOf).filter((c): c is DataSourceChoice => c !== null);
}

/**
 * What was picked for one field, if picking even applies to it.
 *
 * The "a pick wins over the text box" rule, in one place. Every reader of a draft has to
 * ask it — `buildConfig`, `accountKeyFor`, `validateDraft` and the dialog's own render —
 * and restating `field.choices ? … : []` at each of them is four chances for one of them
 * to drift into honouring a stale pick on a field that no longer offers any.
 */
export function pickedIn(
  draft: SourceDraft,
  key: string,
  field: SpecConfigField,
): DataSourceChoice[] {
  return field.choices ? (draft.picked[key] ?? []) : [];
}

/** What a picked choice is STORED as: a bare id when the name adds nothing. */
const storedChoice = (c: DataSourceChoice): string | { id: string; name: string } =>
  c.name && c.name !== c.id ? { id: c.id, name: c.name } : c.id;

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
    // A pick wins over the text box: the two are never both filled, because hand-editing
    // a choosable field clears its picks. A single-value field stores the one entry
    // itself, never a list — `bucket` is a string in config and must stay one.
    const picked = pickedIn(draft, key, field);
    if (picked.length) {
      config[key] =
        field.type === FieldType.LINES ? picked.map(storedChoice) : storedChoice(picked[0]);
      continue;
    }
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
  const [key, field] = named;
  // The ID names the account, never the display name — a renamed channel is the same
  // channel, and letting the label name the account would rename the source with it.
  const picked = pickedIn(draft, key, field);
  if (picked.length) return picked[0].id;
  const raw = (draft.fields[key] ?? '').trim();
  // A multi-value field names the account by its FIRST value: appending a feed
  // must not silently rename the source.
  return field.type === FieldType.LINES ? (splitLines(raw)[0] ?? '') : raw;
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
    // A pick satisfies "has a value" on its own, and needs no pattern check: it came off
    // a list the provider itself just returned, so a regex here could only reject a value
    // the provider says is real.
    const picked = pickedIn(draft, key, field);
    if (picked.length) continue;
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
