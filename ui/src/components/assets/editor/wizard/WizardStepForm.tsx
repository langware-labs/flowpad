import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { WizardIssue } from '@sdk';

import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@src/components/ui/select';

import { ON_FAIL, STEP_KINDS, nextFreeName, type StepKind, type WizardStepDoc } from './wizard-doc';

/** A text field that commits on BLUR, never per keystroke — a keystroke-level
 *  write would rewrite `wizard.json` on every character, and each write costs a
 *  validate plus a reindex. Same rule as `McpForm`'s Field. */
export function CommitField({
  value,
  onCommit,
  placeholder,
  readOnly,
  testId,
  mono,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  testId?: string;
  mono?: boolean;
}) {
  return (
    <Input
      // Uncontrolled between blurs (`defaultValue` + `key`), so a WS entity push
      // landing mid-edit cannot clobber what is being typed or steal the caret.
      // The document is only re-read when its path changes.
      key={value}
      defaultValue={value}
      placeholder={placeholder}
      readOnly={readOnly}
      data-testid={testId}
      className={mono ? 'h-8 font-mono text-xs' : 'h-8 text-sm'}
      onBlur={(e) => {
        if (!readOnly && e.target.value !== value) onCommit(e.target.value);
      }}
    />
  );
}

export function IssueList({ issues }: { issues: WizardIssue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="mt-1">
      {issues.map((issue, i) => (
        <li
          key={i}
          className={`text-xs ${issue.severity === 'warning' ? 'text-amber-600 dark:text-amber-500' : 'text-destructive'}`}
        >
          {issue.msg}
        </li>
      ))}
    </ul>
  );
}

/**
 * A field that OFFERS known names without refusing an unknown one.
 *
 * A datalist, not a Select: a document written elsewhere may name an op, a
 * wizard or a parameter this machine does not have, and a Select would silently
 * render that as empty — erasing the name on the next save. The list offers what
 * is known; the field still accepts anything.
 *
 * `unknown` says nothing when the roster is EMPTY, because an empty roster means
 * the list has not loaded, not that everything is missing.
 */
export function SuggestField({
  value,
  options,
  onCommit,
  readOnly,
  testId,
  placeholder,
  unknownHint,
}: {
  value: string;
  options: string[];
  onCommit: (next: string) => void;
  readOnly?: boolean;
  testId: string;
  placeholder?: string;
  /** Rendered when `value` is set and not among a non-empty `options`. */
  unknownHint?: string;
}) {
  const known = options.length === 0 || options.includes(value);
  return (
    <>
      <input
        key={value}
        list={`${testId}-options`}
        defaultValue={value}
        readOnly={readOnly}
        placeholder={placeholder}
        data-testid={testId}
        className="h-8 w-full rounded-md border border-input bg-transparent px-3 font-mono text-xs"
        onBlur={(e) => {
          if (!readOnly && e.target.value !== value) onCommit(e.target.value);
        }}
      />
      <datalist id={`${testId}-options`}>
        {options.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {value && !known && unknownHint ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-500" data-testid={`${testId}-unknown`}>
          {unknownHint}
        </p>
      ) : null}
    </>
  );
}

/**
 * The step's arguments: a FLAT map from the callee's parameter name to a value.
 *
 * Deliberately two plain boxes per row. `args` is not a template language —
 * there is no `${...}`, and a value is either a name in scope or a literal — so
 * anything more elaborate than key/value would be inventing syntax the runner
 * does not read. The value box offers the names in scope; it accepts any
 * literal, because the form cannot tell which was meant.
 */
function ArgsField({
  args,
  scope,
  readOnly,
  testIdPrefix,
  onSet,
  onRemove,
  onRename,
}: {
  args: Record<string, string> | undefined;
  scope: string[];
  readOnly?: boolean;
  testIdPrefix: string;
  onSet: (key: string, value: string) => void;
  onRemove: (key: string) => void;
  onRename: (from: string, to: string) => void;
}) {
  const { t } = useLingui();
  const entries = Object.entries(args ?? {});

  return (
    <div className="flex flex-col gap-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-center gap-1.5">
          <div className="w-40 shrink-0">
            <CommitField
              mono
              readOnly={readOnly}
              value={key}
              testId={`${testIdPrefix}-key-${key}`}
              placeholder={t`parameter`}
              onCommit={(next) => next.trim() && onRename(key, next.trim())}
            />
          </div>
          <div className="min-w-0 flex-1">
            <SuggestField
              readOnly={readOnly}
              value={value}
              options={scope}
              testId={`${testIdPrefix}-value-${key}`}
              placeholder={t`a name in scope, or a literal`}
              onCommit={(next) => onSet(key, next)}
            />
          </div>
          {!readOnly && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 shrink-0 p-0"
              onClick={() => onRemove(key)}
              title={t`Remove this argument`}
              data-testid={`${testIdPrefix}-remove-${key}`}
            >
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          )}
        </div>
      ))}
      {!readOnly && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-1.5 text-[11px]"
            data-testid={`${testIdPrefix}-add`}
            // A blank key is a legal placeholder in the FORM but not in the
            // document, so the new row is named rather than empty — an empty
            // key would fail validation before it could be typed into.
            onClick={() => onSet(nextFreeName(Object.keys(args ?? {}), 'arg_'), '')}
          >
            <Plus className="h-3 w-3" />
            <Trans>Add argument</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}

/** What each kind's `ref` names, said in the field's own label. The words are
 *  the difference between the kinds, so they are not left to be guessed. */
const REF_LABEL: Record<StepKind, string> = {
  compute: 'Op',
  wizard: 'Wizard',
};

/**
 * One step, as an editable form.
 *
 * Every edit is expressed as a PATH into the document (`['steps', 3, 'args',
 * 'API_KEY']`) rather than as a reshaped step object, so a key this form does
 * not render survives an edit to the field beside it.
 */
export function WizardStepForm({
  step,
  index,
  expanded,
  onToggle,
  onSet,
  onRemove,
  onSetKind,
  onDelete,
  readOnly,
  issuesAt,
  refOptions,
  scope,
  duplicateId,
}: {
  step: WizardStepDoc;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onSet: (path: (string | number)[], value: unknown) => void;
  onRemove: (path: (string | number)[]) => void;
  onSetKind: (kind: StepKind) => void;
  onDelete: () => void;
  readOnly: boolean;
  issuesAt: (path: (string | number)[]) => WizardIssue[];
  /** Names this step's `kind` can refer to — offered, never enforced. */
  refOptions: string[];
  /** Names an `args` value may refer to: the wizard's parameters and the steps
   *  before this one. */
  scope: string[];
  /** Another step declares this id too, so their outcomes collide. */
  duplicateId?: boolean;
}) {
  const { t } = useLingui();
  const kind: StepKind = step.kind ?? 'compute';
  const at = (...rest: (string | number)[]) => ['steps', index, ...rest];
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <li className="rounded-md border border-border" data-testid={`wizard-step-form-${step.id}`}>
      <div className="flex items-center gap-2 p-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 items-center gap-2 text-left"
          data-testid={`wizard-step-toggle-${step.id}`}
        >
          <Chevron className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="font-mono text-xs text-muted-foreground">{step.id}</span>
          <span className="text-sm">{step.label || ''}</span>
          <span className="font-mono text-[11px] text-muted-foreground/70">
            {kind}
            {step.ref ? ` · ${step.ref}` : ''}
          </span>
        </button>
        {!readOnly && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={onDelete}
            title={t`Delete this step`}
            data-testid={`wizard-step-delete-${step.id}`}
          >
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        )}
      </div>

      {duplicateId ? (
        <p
          className="px-2 pb-2 text-[11px] text-amber-600 dark:text-amber-500"
          data-testid={`wizard-step-duplicate-${step.id}`}
        >
          {/* Not cosmetic: the id is the activity address and the key an outcome
              joins on, so two steps sharing one collapse into a single node and
              one result silently replaces the other. */}
          <Trans>Another step already uses this id — their results will overwrite each other.</Trans>
        </p>
      ) : null}

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-border p-3">
          <label className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              <Trans>Id</Trans>
            </span>
            <CommitField
              mono
              readOnly={readOnly}
              value={step.id}
              testId={`wizard-step-id-${step.id}`}
              // Refuse a blank rather than write one: `NonBlank` would reject it
              // and the whole document would stop loading over one empty box.
              onCommit={(v) => v.trim() && onSet(at('id'), v.trim())}
            />
          </label>
          <label className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              <Trans>Label</Trans>
            </span>
            <CommitField
              readOnly={readOnly}
              value={step.label ?? ''}
              testId={`wizard-step-label-${step.id}`}
              onCommit={(v) => (v.trim() ? onSet(at('label'), v) : onRemove(at('label')))}
            />
          </label>
          <label className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              <Trans>About</Trans>
            </span>
            <CommitField
              readOnly={readOnly}
              value={step.description ?? ''}
              testId={`wizard-step-description-${step.id}`}
              onCommit={(v) =>
                v.trim() ? onSet(at('description'), v) : onRemove(at('description'))
              }
            />
          </label>

          <label className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              <Trans>Kind</Trans>
            </span>
            <Select
              value={kind}
              disabled={readOnly}
              // ATOMIC with the `ref` it invalidates: the same string means an
              // op under `compute` and a parameter under `ask`, so they change
              // in one transition rather than leaving a step that points at
              // something which does not exist while looking deliberate.
              onValueChange={(value) => onSetKind(value as StepKind)}
            >
              <SelectTrigger className="h-8" data-testid={`wizard-step-kind-${step.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STEP_KINDS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <Section title={REF_LABEL[kind]}>
            <SuggestField
              readOnly={readOnly}
              value={step.ref ?? ''}
              options={refOptions}
              testId={`wizard-step-ref-${step.id}`}
              placeholder={kind === 'compute' ? t`an op name` : t`a wizard name`}
              unknownHint={t`Nothing named "${step.ref ?? ''}" on this machine — the step will fail when it runs.`}
              onCommit={(v) => v.trim() && onSet(at('ref'), v.trim())}
            />
            <IssueList issues={issuesAt(at('ref'))} />
          </Section>

          <Section title={t`Arguments`}>
            <ArgsField
              readOnly={readOnly}
              args={step.args}
              scope={scope}
              testIdPrefix={`wizard-step-args-${step.id}`}
              onSet={(key, value) => onSet(at('args', key), value)}
              onRemove={(key) => onRemove(at('args', key))}
              onRename={(from, to) => {
                if (from === to) return;
                onSet(at('args', to), step.args?.[from] ?? '');
                onRemove(at('args', from));
              }}
            />
            <IssueList issues={issuesAt(at('args'))} />
          </Section>

          <label className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              <Trans>If it fails</Trans>
            </span>
            <Select
              value={step.on_fail ?? 'abort'}
              disabled={readOnly}
              onValueChange={(value) => onSet(at('on_fail'), value)}
            >
              <SelectTrigger className="h-8" data-testid={`wizard-step-onfail-${step.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ON_FAIL.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <IssueList issues={issuesAt(at())} />
        </div>
      )}
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{title}</span>
      {children}
    </div>
  );
}
