import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';

import { Input } from '@src/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';

/** Sentinel for "no value": Radix reserves `''` for the placeholder state, so
 *  an empty-string `SelectItem` throws rather than rendering a clear option. */
const UNSET = '__unset__';

/**
 * A CLOSED choice field — a real dropdown, not a suggestion list.
 *
 * The sibling `AgentSelectField` is free-text-with-datalist because most of
 * these fields are advisory (`model` takes a tier *or* a concrete model id, so
 * a closed list would make valid values unrepresentable). `worker_type` is the
 * exception: the drivers are a fixed set of four, and anything outside it has
 * no factory key to resolve to, so free text there only ever produces a broken
 * agent.
 *
 * An `extraValue` outside `options` is still rendered as its own item rather
 * than dropped. A document may legitimately carry the OTHER vocabulary
 * (`claude_code` rather than `claude` — `worker_type_value()`/`driver_key()`
 * accept both), and a control that silently could not represent the value on
 * disk would rewrite it on the next unrelated edit.
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
 * Comma-separated list editor for a DECLARED-ONLY field.
 *
 * `tools`, `disallowed_tools` and `subagents` round-trip through `agent.md` and
 * show on the agent's card, but nothing projects them into the worker yet — no
 * `AgentOptions` subclass has a field to carry them. An earlier version of this
 * control offered "inherited / revoke all", which claimed a gate the system
 * does not apply. It says what is true instead, and the affordance returns with
 * enforcement.
 *
 * `skills` and `mcp_servers` are no longer edited here — the agent-resources
 * navigator (Zone B) wires them against the real installed lists. They carry
 * the same not-yet-enforced caveat there.
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
