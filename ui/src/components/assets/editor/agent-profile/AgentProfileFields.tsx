import { ReactNode, useEffect, useState } from 'react';
import { Trans } from '@lingui/react/macro';

import { Input } from '@src/components/ui/input';

/** A titled block in the profile page. */
export function AgentSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-8 border-t border-border pt-6">
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Labelled free-text field that commits on blur. */
export function AgentField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="block space-y-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
      />
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
  options,
  placeholder,
  onCommit,
}: {
  label: string;
  value?: string | null;
  options: readonly string[];
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
 * Comma-separated list editor.
 *
 * `triState` is set ONLY for the two fields that are genuinely `Optional` in
 * the backend — `tools` and `disallowed_tools` (`Optional[list[str]] = None`).
 * For those, unset means "inherit everything the harness allows" and `[]` means
 * "revoke", and `agent_default_body` preserves the difference, so the UI must
 * too: an empty input means unset, and revoking is an explicit action.
 *
 * The other list fields (`skills`, `mcp_servers`, `subagents`,
 * `additional_dirs`) are `default_factory=list` — always `[]`, never null — so
 * showing them as "revoked" would be a lie about what the agent is configured
 * to do. They get a plain input.
 */
export function AgentListField({
  label,
  value,
  triState = false,
  onCommit,
}: {
  label: string;
  value?: string[] | null;
  triState?: boolean;
  onCommit: (value: string[] | null | undefined) => void;
}) {
  const text = (value ?? []).join(', ');
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);

  const isUnset = value == null;
  const isRevoked = Array.isArray(value) && value.length === 0;

  const commit = () => {
    if (draft === text) return;
    const items = draft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length) return onCommit(items);
    // Empty input: "unset" for a tri-state field (revoking is explicit),
    // plain [] for a field that has no unset state.
    onCommit(triState ? undefined : []);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        {triState ? (
          <span className="text-[11px] text-muted-foreground">
            {isUnset ? (
              <Trans>inherited</Trans>
            ) : isRevoked ? (
              <button type="button" className="underline" onClick={() => onCommit(undefined)}>
                <Trans>revoked — inherit instead</Trans>
              </button>
            ) : (
              <button type="button" className="underline" onClick={() => onCommit([])}>
                <Trans>revoke all</Trans>
              </button>
            )}
          </span>
        ) : null}
      </div>
      <Input
        value={draft}
        placeholder={triState && isUnset ? '—' : ''}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
    </div>
  );
}
