import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ExternalLink, Loader2, Plus, Zap } from 'lucide-react';
import { Agent, QueryRequest, Wizard, type WizardIssue, type WizardValidation } from '@sdk';

import { Button } from '@src/components/ui/button';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useAssetTriggers } from '@src/hooks/flow-hooks/useAssetTriggers';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';

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
  wizard,
}: {
  doc: WizardDoc;
  /** The entity, for its child assets — a trigger is one. */
  wizard: Wizard;
  commit: (edit: (previous: WizardDoc) => WizardDoc) => Promise<void>;
  validation: WizardValidation | null;
  saveError: string | null;
  saving: boolean;
  readOnly: boolean;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState<string | null>(null);
  const steps = doc.steps ?? [];

  // Installed agents, to OFFER in the agentic step's picker. A failure here
  // costs the datalist and nothing else — the field still accepts any name.
  const { data: agentRows } = useEntitiesQuery<Agent>(
    useMemo(() => new QueryRequest({ type: Agent.type, name: 'wizard editor agents' }), []),
  );
  const agents = useMemo(
    () => (agentRows ?? []).map((a: Agent) => a.name ?? '').filter(Boolean).sort(),
    [agentRows],
  );

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
            agents={agents}
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

      <TriggerRows wizard={wizard} />

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

/**
 * What invokes this wizard, and a way to go look at it.
 *
 * Read-only, deliberately: a declared trigger is reconciled into a real
 * `Trigger` row at STARTUP only, so an editor here would promise a change that
 * does not happen until the next restart. What is missing today is not editing
 * — it is being able to see the thing at all, and to reach the row that holds
 * whether it has actually fired.
 */
/**
 * What invokes this wizard — its trigger CHILD ASSETS.
 *
 * Read-only here: a trigger is its own asset with its own row, and that row
 * carries runtime state (how many times it has fired) no document should be
 * able to claim. This says what exists, and gets you to it.
 *
 * Sourced from CONTAINMENT, not from the document. The previous version walked
 * `doc.triggers` and re-derived the backend's `wizard_<slug>_<index>` uname in
 * TypeScript to find each row — a slug algorithm duplicated across two
 * languages and keyed POSITIONALLY, so reordering a wizard's triggers matched
 * the wrong rows and swapped their fire counts.
 */
function TriggerRows({ wizard }: { wizard: Wizard }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const triggers = useAssetTriggers(wizard.typeId);

  return (
    <section className="flex flex-col gap-1" data-testid="wizard-triggers">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">
        <Trans>Runs itself when</Trans>
      </span>

      {triggers.length === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="wizard-no-triggers">
          {/* Names the folder, because that IS the answer and it is not
              discoverable from this screen. */}
          <Trans>
            Nothing — this wizard is run by hand. Add a trigger asset under its
            agentic-assets/trigger/ folder to have it run itself.
          </Trans>
        </p>
      ) : (
        triggers.map((row, index) => (
          <div
            key={row.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5"
            data-testid={`wizard-trigger-${index}`}
          >
            <Zap className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <code className="font-mono text-xs">{row.tag_pattern || row.name}</code>
            {row.tag_target ? (
              <span className="text-[11px] text-muted-foreground">
                <Trans>about</Trans> <code className="font-mono">{row.tag_target}</code>
              </span>
            ) : null}
            {row.fire_once ? (
              <span className="rounded border border-border px-1 text-[11px] text-muted-foreground">
                <Trans>once per machine</Trans>
              </span>
            ) : null}
            <span className="flex-1" />
            <span
              className="text-[11px] text-muted-foreground"
              data-testid={`wizard-trigger-fired-${index}`}
            >
              {row.counter ? t`fired ${row.counter}×` : t`not fired yet`}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-1.5 text-[11px]"
              data-testid={`wizard-trigger-open-${index}`}
              onClick={() =>
                // `system: true` is required, not decorative: a wizard's trigger
                // is system-scoped, so the Events screen hides it without this
                // and the link lands on an empty list.
                navigation.openDock(DockPointer.forEvents(row.id, { system: true }))
              }
            >
              <ExternalLink className="h-3 w-3" />
              <Trans>Open trigger</Trans>
            </Button>
          </div>
        ))
      )}
    </section>
  );
}
