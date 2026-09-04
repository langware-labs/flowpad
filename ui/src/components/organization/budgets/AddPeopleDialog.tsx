/**
 * Adding people to a team's budget: type a few, or upload a sheet of them.
 *
 * One dialog for both, because they are the same operation with two input methods — and because a
 * CSV import that lands somewhere else in the UI from the manual add is how the two quietly grow
 * different rules. The CSV fills the same row list the manual form edits, so the sheet is reviewed
 * and correctable before anything is written.
 *
 * Nothing is sent until Add is pressed. A file that half-parses shows what it got and what it could
 * not read, and the good rows are still importable — someone with forty new hires and one bad
 * address should not have to fix the file to make any progress.
 */
import { downloadFile } from '@sdk';
import type { MemberBudget } from '@sdk';
import { Download, Plus, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { notify } from '@src/notifications';

import type { PersonDraft } from './add-people';
import { useAddPeople } from './use-budgets';
import { PEOPLE_CSV_FILENAME, SAMPLE_PEOPLE_CSV, parsePeopleCsv, type PeopleCsvProblem } from './people-csv';

interface DraftRow {
  name: string;
  email: string;
  budget: string;
}

const EMPTY_ROW: DraftRow = { name: '', email: '', budget: '' };

export interface AddPeopleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The team pool the new allowances draw on. */
  poolId: string;
  teamName: string;
  /** The team's current roster — a repeated address re-budgets that person instead of duplicating. */
  existing: readonly MemberBudget[];
}

/** The problem sentences. Kept beside the dialog rather than in the parser so the rules stay pure
 *  and the wording stays translatable in one place. */
function useProblemText() {
  const { t } = useLingui();
  return (problem: PeopleCsvProblem): string => {
    switch (problem.code) {
      case 'missing_email':
        return t`Line ${problem.line}: no email address.`;
      case 'bad_email':
        return t`Line ${problem.line}: "${problem.value}" is not an email address.`;
      case 'bad_budget':
        return t`Line ${problem.line}: "${problem.value}" is not an amount.`;
      case 'duplicate_email':
        return t`Line ${problem.line}: ${problem.value} appears more than once.`;
      default:
        return t`Line ${problem.line}: could not be read.`;
    }
  };
}

export function AddPeopleDialog({ open, onOpenChange, poolId, teamName, existing }: AddPeopleDialogProps) {
  const { t } = useLingui();
  const problemText = useProblemText();
  const fileInput = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<DraftRow[]>([{ ...EMPTY_ROW }]);
  const [problems, setProblems] = useState<string[]>([]);
  const addPeople = useAddPeople();

  const reset = () => {
    setRows([{ ...EMPTY_ROW }]);
    setProblems([]);
  };

  const setRow = (index: number, patch: Partial<DraftRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const { rows: parsed, problems: found } = parsePeopleCsv(await file.text());
    setProblems(found.map(problemText));
    if (parsed.length === 0) {
      if (found.length === 0) setProblems([t`That file has no rows.`]);
      return;
    }
    // Replace rather than append: an upload is "here is my list", and appending would silently
    // double a sheet someone picked twice.
    setRows(
      parsed.map((row) => ({
        name: row.name,
        email: row.email,
        budget: row.budget === null ? '' : String(row.budget),
      })),
    );
  };

  const drafts = (): PersonDraft[] =>
    rows
      .filter((row) => row.email.trim())
      .map((row) => ({
        name: row.name.trim(),
        email: row.email.trim().toLowerCase(),
        budget: row.budget.trim() === '' ? null : Number(row.budget.replace(/[$,\s]/g, '')),
      }));

  const submit = async () => {
    const people = drafts();
    if (people.length === 0) {
      setProblems([t`Add at least one email address.`]);
      return;
    }
    const bad = people.filter((p) => p.budget !== null && (!Number.isFinite(p.budget) || p.budget < 0));
    if (bad.length > 0) {
      setProblems(bad.map((p) => t`${p.email}: the amount must be a number.`));
      return;
    }
    const outcome = await addPeople.mutateAsync({ poolId, drafts: people, existing });
    setProblems(outcome.failed.map((f) => `${f.email} — ${f.reason}`));
    const landed = outcome.added.length + outcome.updated.length;
    if (landed > 0) {
      notify.success({
        title: t`Budgets updated`,
        message: t`${outcome.added.length} added, ${outcome.updated.length} updated in ${teamName}.`,
        id: 'budgets-add',
      });
    }
    // Closed only when everything landed — a dialog that vanishes on a partial failure takes the
    // list of what to fix with it.
    if (outcome.failed.length === 0) {
      reset();
      onOpenChange(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl" data-testid="add-people-dialog">
        <DialogHeader>
          <DialogTitle>{t`Add people to ${teamName}`}</DialogTitle>
          <DialogDescription>
            <Trans>
              Each person gets their own budget drawn from this team. Leave the amount blank for no limit. Someone
              already on this team has their amount updated instead of being added twice.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            data-testid="add-people-csv-input"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              // Cleared so picking the same file twice fires `change` again.
              e.target.value = '';
            }}
          />
          <Button
            size="sm"
            variant="outline"
            data-testid="add-people-upload"
            onClick={() => fileInput.current?.click()}
          >
            <Upload className="h-4 w-4" />
            <Trans>Upload CSV</Trans>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="add-people-sample"
            onClick={() =>
              downloadFile({
                name: PEOPLE_CSV_FILENAME,
                content: new Blob([SAMPLE_PEOPLE_CSV], { type: 'text/csv' }),
              })
            }
          >
            <Download className="h-4 w-4" />
            <Trans>Download sample CSV</Trans>
          </Button>
          <span className="text-xs text-muted-foreground">
            <Trans>Columns: name, email, budget</Trans>
          </span>
        </div>

        <div className="max-h-72 overflow-y-auto">
          <div className="flex flex-col gap-2">
            {rows.map((row, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={row.name}
                  placeholder={t`Name`}
                  aria-label={t`Name`}
                  data-testid={`add-person-name-${index}`}
                  className="h-8 flex-1"
                  onChange={(e) => setRow(index, { name: e.target.value })}
                />
                <Input
                  type="email"
                  value={row.email}
                  placeholder={t`name@example.com`}
                  aria-label={t`Email`}
                  data-testid={`add-person-email-${index}`}
                  className="h-8 flex-1"
                  onChange={(e) => setRow(index, { email: e.target.value })}
                />
                <Input
                  value={row.budget}
                  placeholder={t`unlimited`}
                  aria-label={t`Budget in dollars`}
                  data-testid={`add-person-budget-${index}`}
                  className="h-8 w-28 text-end"
                  inputMode="decimal"
                  onChange={(e) => setRow(index, { budget: e.target.value })}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t`Remove row`}
                  data-testid={`add-person-drop-${index}`}
                  disabled={rows.length === 1}
                  onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <Button
          size="sm"
          variant="outline"
          className="self-start"
          data-testid="add-person-row"
          onClick={() => setRows((current) => [...current, { ...EMPTY_ROW }])}
        >
          <Plus className="h-4 w-4" />
          <Trans>Add another</Trans>
        </Button>

        {problems.length > 0 && (
          <ul className="max-h-32 overflow-y-auto text-xs text-destructive" data-testid="add-people-problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={addPeople.isPending}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void submit()} disabled={addPeople.isPending} data-testid="add-people-submit">
            {addPeople.isPending ? '…' : t`Add`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
