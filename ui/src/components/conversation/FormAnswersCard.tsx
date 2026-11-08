import { ClipboardList } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { cn } from '@src/lib/utils';
import { FORM_EDIT_EVENT, shownValue, type AnswersEntry, type MessageForm } from './message-form';

interface FormAnswersCardProps {
  entry: AnswersEntry;
  /** The form these answer — null while its message is not loaded (ids stand in for labels). */
  form: MessageForm | null;
  /** Who answered — the same card reads the same on both sides. */
  answererName: string;
  /** I answered: I may change my answers (only on the newest card). */
  canChange: boolean;
}

/** The answers a Submit posted: one solid card, identical for the sender and the receiver.
 *  A changed answer shows the new value with the old one struck. */
export function FormAnswersCard({ entry, form, answererName, canChange }: FormAnswersCardProps) {
  const { t } = useLingui();
  const { answers, previous } = entry;
  const changed = new Set(answers.changed ?? []);
  const rows = form
    ? form.fields.filter((f) => f.id in answers.values).map((f) => ({ id: f.id, label: f.label }))
    : Object.keys(answers.values).map((id) => ({ id, label: id }));
  const yes = t`Yes`;
  const no = t`No`;
  const updated = !!answers.supersedes;
  return (
    <div
      className="mt-1 max-w-[640px] rounded-lg border border-border bg-muted px-3 py-2.5 text-sm"
      data-testid="form-answers"
      data-form-id={answers.form_id}
    >
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
        <span className="flex items-center gap-1.5 font-semibold">
          <ClipboardList className="h-3.5 w-3.5" />
          {updated ? t`${answererName}'s answers — updated` : t`${answererName}'s answers`}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {form?.title ?? ''}
          {updated ? ` · ${t`${changed.size} changed`}` : ''}
        </span>
      </div>
      {rows.map(({ id, label }) => {
        const isChanged = updated && changed.has(id);
        const was = isChanged ? previous?.values[id] : undefined;
        return (
          <div
            key={id}
            className={cn('grid grid-cols-[150px_minmax(0,1fr)] gap-2 rounded px-1 py-0.5', isChanged && 'bg-amber-500/10')}
            data-testid={`form-answer-${id}`}
            data-changed={isChanged || undefined}
          >
            <span className="text-muted-foreground">{label}</span>
            <span className="break-words">
              {shownValue(answers.values[id], yes, no)}
              {was !== undefined && (
                <s className="ms-2 text-muted-foreground">{shownValue(was, yes, no)}</s>
              )}
            </span>
          </div>
        );
      })}
      {canChange && (
        <button
          type="button"
          className="mt-1.5 text-xs text-primary underline underline-offset-2 hover:text-primary/80"
          onClick={() => window.dispatchEvent(new CustomEvent(FORM_EDIT_EVENT, { detail: answers.form_id }))}
          data-testid="form-answers-change"
        >
          {t`Change answers`}
        </button>
      )}
    </div>
  );
}
