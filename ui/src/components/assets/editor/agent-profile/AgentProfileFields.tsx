import { useEffect, useState } from 'react';
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
 */
export function AgentChoiceField({
  label,
  value,
  options,
  onCommit,
}: {
  label: string;
  value?: string | null;
  options: readonly string[];
  onCommit: (value: string | undefined) => void;
}) {
  const { t } = useLingui();
  const current = value ?? '';
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
              which is a different thing from the key being absent. */}
          <SelectItem value={UNSET}>
            <span className="text-muted-foreground">{t`Unset`}</span>
          </SelectItem>
          {items.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
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
 * Comma-separated editor for a DECLARED-ONLY field. `tools`,
 * `disallowed_tools` and `subagents` round-trip through `agent.md` but reach no
 * worker yet; `mcp_servers` is listed by the agent-resources pane instead.
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
