/**
 * The Access tab: what the selected node's container confers on it.
 *
 * Every child starts INHERITING — one `('*','*')` role edge, so whatever role
 * you hold on the parent arrives unchanged. Overriding replaces that with
 * explicit mappings ("an admin of this team is a member here, everyone else is a
 * reader"); clearing them puts inherit back.
 *
 * Role matching is EXACT, not rank-aware: a rule for `admin` does not match an
 * `owner`. That is why the hub can refuse a rule set that would lock its author
 * out, and why its message is shown verbatim rather than paraphrased.
 *
 * Body only — the node's name lives in `NodePanel`'s header.
 */
import { TypeId, WILDCARD_ROLE, type AccessRule } from '@sdk';
import { Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { CONFERRABLE_ROLES, LADDER_ROLES } from '@src/components/conversation/participant-display';
import { useAccess } from '@src/hooks/use-access';
import type { NodeData } from '../graph/graphModel';

/** `from_role` may match any role, so the wildcard leads its option list. */
const FROM_ROLE_OPTIONS = [WILDCARD_ROLE, ...LADDER_ROLES];
/** Seeded when switching to Override — an empty list would mean inherit. */
const DEFAULT_RULE: AccessRule = { from_role: WILDCARD_ROLE, to_role: 'reader' };

export function AccessTab({ node, onChanged }: { node: NodeData; onChanged: () => void }) {
  const { t } = useLingui();
  const parent = node.parent;
  const child = useMemo(() => new TypeId(node.type, node.id), [node.type, node.id]);
  const parentTypeId = useMemo(() => (parent ? new TypeId(parent.type, parent.id) : null), [parent]);
  const access = useAccess(parent ? child : null, parentTypeId);

  // Edits stay local until Save, so a half-built rule set is never written and
  // Cancel is a real escape rather than an undo.
  const [draft, setDraft] = useState<AccessRule[] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(null);
    setSaveError(null);
  }, [child.type, child.id, parent?.id]);

  const rules = draft ?? access.rules;
  // The rule list IS the mode: the hub returns none for a pass-through.
  const overriding = rules.length > 0;

  const edit = (next: AccessRule[]) => {
    setSaveError(null);
    setDraft(next);
  };

  const onSave = async () => {
    setSaveError(null);
    try {
      await access.save(rules);
      setDraft(null);
      onChanged();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!parent) {
    return (
      <p className="access-empty">
        <Trans>This entity has no container in this view, so there is no inherited access to edit.</Trans>
      </p>
    );
  }

  if (!access.available) {
    return (
      <p className="access-empty">
        {access.reason === 'local' ? (
          <Trans>Access is managed on the hub.</Trans>
        ) : (
          <Trans>Sign in to view access.</Trans>
        )}
      </p>
    );
  }

  return (
    <>
      <p className="access-parent">
        <Trans>Contained by</Trans>{' '}
        <strong data-testid="access-parent">{parent.label || `${parent.type}-${parent.id}`}</strong>
      </p>

      {access.error ? (
        <p className="access-error" data-testid="access-error">
          {access.error.message}
        </p>
      ) : !access.ready ? (
        <p className="access-empty">
          <Loader2 className="access-spin" size={14} /> <Trans>Loading…</Trans>
        </p>
      ) : (
        <>
          <fieldset className="access-mode">
            <label>
              <input
                type="radio"
                name="access-mode"
                data-testid="access-mode-inherit"
                checked={!overriding}
                onChange={() => edit([])}
              />
              <span>
                <strong>
                  <Trans>Inherit</Trans>
                </strong>
                <em>
                  <Trans>Roles on the parent pass through unchanged.</Trans>
                </em>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="access-mode"
                data-testid="access-mode-override"
                checked={overriding}
                onChange={() => edit(rules.length ? rules : [DEFAULT_RULE])}
              />
              <span>
                <strong>
                  <Trans>Override</Trans>
                </strong>
                <em>
                  <Trans>Map each role on the parent to a role here. Matching is exact.</Trans>
                </em>
              </span>
            </label>
          </fieldset>

          {overriding && (
            <ul className="access-rules" data-testid="access-rules">
              {rules.map((rule, index) => (
                // Keyed by POSITION, not by value: the rows are fully controlled
                // from `rules` and never reordered, so a value-derived key would
                // remount the row on every change and drop focus mid-edit.
                <li key={index} className="access-rule">
                  <select
                    aria-label={t`Role on the parent`}
                    data-testid="access-from-role"
                    value={rule.from_role}
                    onChange={(e) => edit(rules.map((r, i) => (i === index ? { ...r, from_role: e.target.value } : r)))}
                  >
                    {FROM_ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>
                        {role === WILDCARD_ROLE ? t`anyone` : role}
                      </option>
                    ))}
                  </select>
                  <span className="access-arrow">→</span>
                  <select
                    aria-label={t`Role conferred here`}
                    data-testid="access-to-role"
                    value={rule.to_role}
                    onChange={(e) => edit(rules.map((r, i) => (i === index ? { ...r, to_role: e.target.value } : r)))}
                  >
                    {CONFERRABLE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="access-rule-remove"
                    aria-label={t`Remove rule`}
                    onClick={() => edit(rules.filter((_, i) => i !== index))}
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  className="access-add"
                  data-testid="access-add-rule"
                  onClick={() => edit([...rules, DEFAULT_RULE])}
                >
                  <Trans>+ Add rule</Trans>
                </button>
              </li>
            </ul>
          )}

          {saveError && (
            <p className="access-error" data-testid="access-save-error">
              {saveError}
            </p>
          )}

          <div className="access-actions">
            <button type="button" onClick={() => setDraft(null)} disabled={draft === null || access.updating}>
              <Trans>Cancel</Trans>
            </button>
            <button
              type="button"
              className="access-save"
              data-testid="access-save"
              onClick={() => void onSave()}
              disabled={draft === null || access.updating}
            >
              {access.updating ? <Loader2 className="access-spin" size={13} /> : <Trans>Save</Trans>}
            </button>
          </div>
        </>
      )}
    </>
  );
}
