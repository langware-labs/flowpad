import { ReactNode, useEffect, useState } from 'react';

import { Input } from '@src/components/ui/input';

/** A block in the settings rail: optional title, optional one-line hint. */
export function AgentSection({
  title,
  hint,
  children,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section>
      {title ? <h2 className="text-sm font-semibold">{title}</h2> : null}
      {hint ? <p className="mb-3 text-xs text-muted-foreground">{hint}</p> : null}
      {children}
    </section>
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
 * `tools`, `disallowed_tools`, `skills`, `mcp_servers` and `subagents`
 * round-trip through `agent.md` and show on the agent's card, but nothing
 * projects them into the worker yet — no `AgentOptions` subclass has a field
 * to carry them. An earlier version of this control offered
 * "inherited / revoke all", which claimed a gate the system does not apply.
 * It says what is true instead, and the affordance returns with enforcement.
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
