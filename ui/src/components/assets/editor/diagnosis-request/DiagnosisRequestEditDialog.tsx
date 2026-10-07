/**
 * Change an open diagnosis request: its instructions, how long it accepts runs (counted from now --
 * so it also reopens a closed one), the largest run, and -- optionally -- a new LLM budget, which
 * replaces the one the runner spends now. The hub clamps the window to 7 days and the run to 10MB.
 */
import { DiagnosisRequest } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import React, { useEffect, useState } from 'react';

import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Label } from '@src/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Textarea } from '@src/components/ui/textarea';
import { notify } from '@src/notifications';

import {
  BudgetFields,
  DEFAULT_BUDGET,
  fundingBody,
  HoursSelect,
  MAX_RUN_MB,
  type Budget,
} from './DiagnosisRequestCreateDialog';
import { editRequest, errorText, formatWhen } from './diagnosis-request-api';

const MB = 1024 * 1024;

export const DiagnosisRequestEditDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: DiagnosisRequest;
}> = ({ open, onOpenChange, request }) => {
  const { t } = useLingui();
  const [instructions, setInstructions] = useState(request.instructions ?? '');
  const currentMb = String(Math.round((request.max_run_bytes ?? 2 * MB) / MB));
  const [writeHours, setWriteHours] = useState('');
  const [maxRunMb, setMaxRunMb] = useState(currentMb);
  const [fund, setFund] = useState(false);
  const [budget, setBudget] = useState<Budget>(DEFAULT_BUDGET);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every opening starts from what the request holds now.
  useEffect(() => {
    if (!open) return;
    setInstructions(request.instructions ?? '');
    setWriteHours('');
    setMaxRunMb(currentMb);
    setFund(false);
    setBudget(DEFAULT_BUDGET);
    setError(null);
  }, [open, request.instructions, currentMb]);

  const instructionsChanged = instructions.trim() !== (request.instructions ?? '').trim();
  const sizeChanged = maxRunMb !== currentMb;
  const changed = instructionsChanged || !!writeHours || sizeChanged;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await editRequest(request.id, {
        ...(instructionsChanged ? { instructions: instructions.trim() } : {}),
        ...(writeHours ? { write_hours: Number(writeHours) } : {}),
        ...(sizeChanged ? { max_run_mb: Number(maxRunMb) } : {}),
        ...(fund ? { funding: fundingBody(budget) } : {}),
      });
      onOpenChange(false);
      notify.success({ title: t`Diagnosis request updated` });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <Trans>Edit diagnosis request</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="diagnosis-edit-instructions">
              <Trans>Instructions for their agent</Trans>{' '}
              <span className="text-xs font-normal text-muted-foreground">
                <Trans>— one step per line, optional</Trans>
              </span>
            </Label>
            <Textarea
              id="diagnosis-edit-instructions"
              autoFocus
              rows={5}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              data-testid="diagnosis-request-edit-instructions"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="diagnosis-edit-write-hours">
                <Trans>Accepts runs for</Trans>{' '}
                <span className="text-xs font-normal text-muted-foreground">
                  <Trans>— from now</Trans>
                </span>
              </Label>
              <HoursSelect
                id="diagnosis-edit-write-hours"
                value={writeHours}
                onChange={setWriteHours}
                placeholder={t`Keep — until ${formatWhen(request.write_expires_at)}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="diagnosis-edit-max-mb">
                <Trans>Largest run</Trans>
              </Label>
              <Select value={maxRunMb} onValueChange={setMaxRunMb}>
                <SelectTrigger id="diagnosis-edit-max-mb" dir="ltr">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MAX_RUN_MB.map((mb) => (
                    <SelectItem key={mb} value={mb}>
                      {mb} MB
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-1">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={fund}
                  onCheckedChange={(on) => setFund(on === true)}
                  data-testid="diagnosis-request-edit-fund"
                />
                {request.llm_endpoint_typeid ? (
                  <Trans>Replace their LLM budget</Trans>
                ) : (
                  <Trans>Pay for their LLM</Trans>
                )}
              </label>
            </legend>
            <p className="text-xs text-muted-foreground">
              {request.llm_endpoint_typeid ? (
                <Trans>The new budget takes over at once; the current one is closed. What was spent stays spent.</Trans>
              ) : (
                <Trans>
                  For someone with no token source of their own. They spend it by the request id, up to the cap and
                  until it expires.
                </Trans>
              )}
            </p>
            {fund && <BudgetFields budget={budget} onChange={setBudget} />}
          </fieldset>

          {error && (
            <p className="text-xs text-destructive" data-testid="diagnosis-request-edit-error">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={busy || (!changed && !fund) || (fund && !budget.source)}
            onClick={() => void save()}
            data-testid="diagnosis-request-edit-save"
          >
            {busy ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
