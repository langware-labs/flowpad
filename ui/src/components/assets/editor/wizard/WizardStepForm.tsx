import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
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

import {
  ACTION_KINDS,
  actionKindOf,
  PLATFORMS,
  type ActionKind,
  type WizardStepDoc,
} from './wizard-doc';

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

function IssueList({ issues }: { issues: WizardIssue[] }) {
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
 * The per-OS command map, which appears three times in a step (precondition,
 * command, verify) with identical shape — hence one component rather than three
 * copies that drift.
 *
 * An empty box REMOVES that platform's key rather than writing `""`: an empty
 * string is a command, and it is one that succeeds, which would silently turn a
 * precondition into "always satisfied".
 */
function CommandsField({
  commands,
  onSet,
  onRemove,
  readOnly,
  issues,
  testIdPrefix,
}: {
  commands: Record<string, string> | undefined;
  onSet: (platform: string, command: string) => void;
  onRemove: (platform: string) => void;
  readOnly?: boolean;
  issues: WizardIssue[];
  testIdPrefix: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      {PLATFORMS.map((platform) => (
        <label key={platform} className="grid grid-cols-[4.5rem_1fr] items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">{platform}</span>
          <CommitField
            mono
            readOnly={readOnly}
            testId={`${testIdPrefix}-${platform}`}
            value={commands?.[platform] ?? ''}
            onCommit={(next) => (next.trim() ? onSet(platform, next) : onRemove(platform))}
          />
        </label>
      ))}
      <IssueList issues={issues} />
    </div>
  );
}

/**
 * One step, as an editable form.
 *
 * Every edit is expressed as a PATH into the document (`['steps', 3, 'verify',
 * 'commands', 'darwin']`) rather than as a reshaped step object, so a key this
 * form does not render — a `satisfied_codes`, a `timeout_seconds` — survives an
 * edit to the field beside it.
 */
export function WizardStepForm({
  step,
  index,
  expanded,
  onToggle,
  onSet,
  onRemove,
  onSetAction,
  onDelete,
  readOnly,
  issuesAt,
}: {
  step: WizardStepDoc;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onSet: (path: (string | number)[], value: unknown) => void;
  onRemove: (path: (string | number)[]) => void;
  onSetAction: (kind: ActionKind) => void;
  onDelete: () => void;
  readOnly: boolean;
  issuesAt: (path: (string | number)[]) => WizardIssue[];
}) {
  const { t } = useLingui();
  const kind = actionKindOf(step);
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
              <Trans>Action</Trans>
            </span>
            <Select
              value={kind ?? ''}
              disabled={readOnly}
              // ATOMIC: the old action is dropped and the new one seeded in one
              // transition, so the document never passes through a state with
              // zero or two actions — which the backend rejects, and which would
              // put an error banner on a change not yet finished.
              onValueChange={(value) => onSetAction(value as ActionKind)}
            >
              <SelectTrigger className="h-8" data-testid={`wizard-step-kind-${step.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTION_KINDS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          {kind === 'command' && (
            <Section title={t`Runs`}>
              <CommandsField
                readOnly={readOnly}
                testIdPrefix={`wizard-step-command-${step.id}`}
                commands={step.command?.commands}
                issues={issuesAt(at('command', 'commands'))}
                onSet={(p, c) => onSet(at('command', 'commands', p), c)}
                onRemove={(p) => onRemove(at('command', 'commands', p))}
              />
            </Section>
          )}

          {kind === 'input' && (
            <Section title={t`Asks for`}>
              <CommitField
                mono
                readOnly={readOnly}
                value={step.input?.name ?? ''}
                testId={`wizard-step-input-${step.id}`}
                placeholder={t`value name`}
                onCommit={(v) => v.trim() && onSet(at('input', 'name'), v.trim())}
              />
              <IssueList issues={issuesAt(at('input'))} />
            </Section>
          )}

          {kind === 'process' && (
            <p className="text-xs text-muted-foreground">
              <Trans>
                This step launches an agent. Editing a process step is not supported here yet —
                change it in the file.
              </Trans>
            </p>
          )}

          <Section title={t`Skip if`}>
            <CommandsField
              readOnly={readOnly}
              testIdPrefix={`wizard-step-precondition-${step.id}`}
              commands={step.precondition?.commands}
              issues={issuesAt(at('precondition', 'commands'))}
              onSet={(p, c) => onSet(at('precondition', 'commands', p), c)}
              onRemove={(p) => onRemove(at('precondition', 'commands', p))}
            />
          </Section>

          <Section title={t`Proved by`}>
            <CommandsField
              readOnly={readOnly}
              testIdPrefix={`wizard-step-verify-${step.id}`}
              commands={step.verify?.commands}
              issues={issuesAt(at('verify', 'commands'))}
              onSet={(p, c) => onSet(at('verify', 'commands', p), c)}
              onRemove={(p) => onRemove(at('verify', 'commands', p))}
            />
          </Section>

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
