import { useEffect, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react/macro';

import { Input } from '@src/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';

/** Sentinel for "no value": Radix reserves `''` for the placeholder state, so
 *  an empty-string `SelectItem` throws rather than rendering a clear option. */
const UNSET = '__unset__';

/**
 * A CLOSED choice field. `worker_type` is the exception to `AgentSelectField`:
 * the drivers are a fixed four, so free text only produces a broken agent. A
 * value outside `options` still renders as its own item rather than be dropped.
 * `labels` maps a stored value to its display text; unmapped values show as-is.
 */
export function AgentChoiceField({
  label,
  value,
  options,
  labels,
  defaultValue,
  onCommit,
}: {
  label: string;
  value?: string | null;
  options: readonly string[];
  labels?: Readonly<Partial<Record<string, string>>>;
  /** What an absent value means. When set there is no Unset item: absent and
   *  the default are the same state, so there is nothing to clear to. */
  defaultValue?: string;
  onCommit: (value: string | undefined) => void;
}) {
  const { t } = useLingui();
  const current = value || defaultValue || '';
  const items = current && !options.includes(current) ? [...options, current] : options;
  return (
    <label className="block space-y-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Select
        value={current || UNSET}
        onValueChange={(next) => onCommit(next === UNSET ? undefined : next)}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {/* Clearing must stay reachable: the field is optional, and the
              backend falls back to its own default when it is absent. Named
              for the STATE, not for whichever value the backend would pick —
              showing the default's name here reads as though it were selected,
              which is a different thing from the key being absent. A field
              with a `defaultValue` has no such state, so it offers no Unset. */}
          {defaultValue === undefined && (
            <SelectItem value={UNSET}>
              <span className="text-muted-foreground">{t`Unset`}</span>
            </SelectItem>
          )}
          {items.map((o) => (
            <SelectItem key={o} value={o}>
              {labels?.[o] ?? o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

/**
 * A suggestion-backed text field: the vocabulary is advisory, so the control
 * stays a free-text input with a datalist rather than a hard `<select>`.
 *
 * That is deliberate — `model` accepts a tier *or* a concrete model id, and
 * none of these fields is constrained backend-side, so a closed dropdown would
 * make existing valid values unrepresentable.
 */
export function AgentSelectField({
  label,
  value,
  options = [],
  placeholder,
  onCommit,
}: {
  label: string;
  value?: string | null;
  options?: readonly string[];
  placeholder?: string;
  onCommit: (value: string | undefined) => void;
}) {
  const current = value ?? '';
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const listId = `agent-opts-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <label className="block space-y-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input
        value={draft}
        list={listId}
        placeholder={placeholder ?? '—'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next !== current) onCommit(next === '' ? undefined : next);
        }}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </label>
  );
}

/**
 * The agent's phone number as its two stored parts. Commits on blur once both
 * parts are filled (or both are cleared, which drops the field); the backend
 * normalises `+972` / `055-770-9288` and refuses what is not a number.
 */
export function AgentPhoneField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value?: { country_code: string; number: string } | null;
  onCommit: (value: { country_code: string; number: string } | undefined) => void;
}) {
  const { t } = useLingui();
  // Memoised so the pair is ONE value: the resync below is the same
  // `setDraft(current)` idiom as the text fields, not a per-part effect.
  const current = useMemo(
    () => ({ country_code: value?.country_code ?? '', number: value?.number ?? '' }),
    [value?.country_code, value?.number],
  );
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);

  const commit = () => {
    const next = { country_code: draft.country_code.trim(), number: draft.number.trim() };
    if (next.country_code === current.country_code && next.number === current.number) return;
    if (!next.country_code && !next.number) onCommit(undefined);
    else if (next.country_code && next.number) onCommit(next);
  };

  return (
    <div className="space-y-1.5" data-testid="agent-phone-field">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex gap-2">
        <Input
          className="w-20"
          value={draft.country_code}
          placeholder="+972"
          inputMode="tel"
          aria-label={t`Country code`}
          onChange={(e) => setDraft((d) => ({ ...d, country_code: e.target.value }))}
          onBlur={commit}
        />
        <Input
          value={draft.number}
          placeholder="055-770-9288"
          inputMode="tel"
          aria-label={t`Phone number`}
          onChange={(e) => setDraft((d) => ({ ...d, number: e.target.value }))}
          onBlur={commit}
        />
      </div>
    </div>
  );
}

/**
 * Comma-separated editor for a DECLARED-ONLY field. `tools`,
 * `disallowed_tools` and `subagents` round-trip through `agent.json` but reach no
 * worker yet. `mcp_servers` is NOT one of these — it is derived rather than
 * typed, and it does reach the worker; see `AgentMcpField`.
 */
export function AgentListField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value?: string[] | null;
  onCommit: (value: string[] | undefined) => void;
}) {
  const text = (value ?? []).join(', ');
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);

  return (
    <div className="space-y-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === text) return;
          const items = draft
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
          onCommit(items.length ? items : undefined);
        }}
      />
    </div>
  );
}
