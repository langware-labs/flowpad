import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2, Plus } from 'lucide-react';
import type { WizardIssue, WizardValidation } from '@sdk';

import { Button } from '@src/components/ui/button';

import { WizardStepForm, CommitField } from './WizardStepForm';
import {
  blankStep,
  issuesByLoc,
  orphanIssues,
  removeIn,
  setIn,
  setStepAction,
  type ActionKind,
  type WizardDoc,
} from './wizard-doc';

/**
 * The editable document.
 *
 * Every edit goes through `commit`, which validates the CANDIDATE before any
 * bytes reach disk — a wizard document that fails validation does not merely
 * look wrong, it makes the wizard vanish from the product, because the indexer's
 * reader swallows a malformed one.
 */
export function WizardForm({
  doc,
  commit,
  validation,
  saveError,
  saving,
  readOnly,
}: {
  doc: WizardDoc;
  commit: (edit: (previous: WizardDoc) => WizardDoc) => Promise<void>;
  validation: WizardValidation | null;
  saveError: string | null;
  saving: boolean;
  readOnly: boolean;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState<string | null>(null);
  const steps = doc.steps ?? [];

  const byLoc = issuesByLoc(validation?.issues);
  const rendered = new Set<string>();
  const issuesAt = (path: (string | number)[]): WizardIssue[] => {
    const key = path.join('.');
    rendered.add(key);
    return byLoc.get(key) ?? [];
  };

  const set = (path: (string | number)[], value: unknown) =>
    void commit((previous) => setIn(previous, path, value));
  const remove = (path: (string | number)[]) => void commit((previous) => removeIn(previous, path));

  return (
    <div className="flex flex-col gap-3" data-testid="wizard-form">
      {readOnly && (
        <p className="rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground" data-testid="wizard-read-only">
          {/* The backend's word, not this component's guess — `validate` returns
              `read_only` so one rule decides it for both tiers. */}
          {validation?.read_only_reason || (
            <Trans>This wizard ships with Flowpad and cannot be edited here.</Trans>
          )}
        </p>
      )}

      <label className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          <Trans>Name</Trans>
        </span>
        <CommitField
          readOnly={readOnly}
          value={doc.name ?? ''}
          testId="wizard-doc-name"
          onCommit={(v) => v.trim() && set(['name'], v.trim())}
        />
      </label>
      <label className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          <Trans>About</Trans>
        </span>
        <CommitField
          readOnly={readOnly}
          value={doc.description ?? ''}
          testId="wizard-doc-description"
          onCommit={(v) => (v.trim() ? set(['description'], v) : remove(['description']))}
        />
      </label>

      <ul className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <WizardStepForm
            key={`${index}-${step.id}`}
            step={step}
            index={index}
            readOnly={readOnly}
            expanded={expanded === step.id}
            onToggle={() => setExpanded(expanded === step.id ? null : step.id)}
            onSet={set}
            onRemove={remove}
            onSetAction={(kind: ActionKind) =>
              void commit((previous) => setStepAction(previous, index, kind))
            }
            onDelete={() => remove(['steps', index])}
            issuesAt={issuesAt}
          />
        ))}
      </ul>

      {!readOnly && (
        <div>
          <Button
            size="sm"
            variant="secondary"
            className="h-7 gap-1.5"
            data-testid="wizard-add-step"
            onClick={() =>
              void commit((previous) =>
                setIn(previous, ['steps', (previous.steps ?? []).length], blankStep(previous.steps ?? [])),
              )
            }
          >
            <Plus className="h-3.5 w-3.5" />
            <Trans>Add step</Trans>
          </Button>
        </div>
      )}

      {doc.triggers?.length ? (
        <p className="text-xs text-muted-foreground">
          {/* Reconciled at startup only, so saying "saved" without this would be
              a lie about when the change takes effect. */}
          <Trans>
            This wizard runs itself on an event. Trigger changes take effect after a restart.
          </Trans>
        </p>
      ) : null}

      {/* Issues addressing a field no longer rendered still have to be shown —
          an error nothing displays is worse than a clumsily placed one. */}
      {orphanIssues(validation?.issues, rendered).map((issue, i) => (
        <p
          key={i}
          className={`text-xs ${issue.severity === 'warning' ? 'text-amber-600 dark:text-amber-500' : 'text-destructive'}`}
          data-testid="wizard-issue"
        >
          {(issue.loc ?? []).join('.') || t`document`}: {issue.msg}
        </p>
      ))}

      {saveError && (
        <p className="text-xs text-destructive" data-testid="wizard-save-error">
          <Trans>Failed to save: {saveError}</Trans>
        </p>
      )}
      {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
    </div>
  );
}
