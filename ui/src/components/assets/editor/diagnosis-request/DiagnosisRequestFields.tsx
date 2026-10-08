/**
 * The request's editable fields, edited where they are shown. Each one saves through the type's
 * `edit` action on its own, so the pane follows the row as the backend rewrites it:
 *
 * - the instructions -- saved when the owner presses Save;
 * - whether the runner is asked anything -- saved when toggled;
 * - how long it accepts runs (counted from NOW, so it also reopens a closed request) and the
 *   largest run -- saved when picked; the hub clamps them to 7 days and 10MB;
 * - the LLM budget -- a new one replaces the one the runner spends now.
 */
import { DiagnosisRequest } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Textarea } from '@src/components/ui/textarea';
import { cn } from '@src/lib/utils';

import {
  BudgetFields,
  DEFAULT_BUDGET,
  fundingBody,
  HoursSelect,
  MAX_RUN_MB,
  type Budget,
} from './DiagnosisRequestCreateDialog';
import { editRequest, errorText, formatWhen, type EditRequestBody } from './diagnosis-request-api';

const MB = 1024 * 1024;

/** One `edit` call at a time per field, with its own busy flag and error. */
function useEdit(id: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (body: EditRequestBody): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await editRequest(id, body);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, save };
}

function Row({ label, htmlFor, children }: { label: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={htmlFor} className="w-44 shrink-0 text-muted-foreground">
        {label}
      </label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="text-xs text-destructive">{error}</p> : null;
}

/** What their agent is asked to do. Save appears once the text differs from the request's. */
export function InstructionsField({ request }: { request: DiagnosisRequest }) {
  const saved = request.instructions ?? '';
  const [text, setText] = useState(saved);
  const { busy, error, save } = useEdit(request.id);
  // A save (here or elsewhere) rewrites the row; the box follows it.
  useEffect(() => setText(saved), [saved]);
  const dirty = text.trim() !== saved.trim();

  return (
    <div className="space-y-2">
      <Textarea
        rows={4}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        data-testid="diagnosis-request-instructions-field"
      />
      {dirty && (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void save({ instructions: text.trim() })}
            data-testid="diagnosis-request-instructions-save"
          >
            {busy ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setText(saved)}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

/** Whether `flow diagnose <id>` asks its runner anything (off: nothing is asked, the result is always
 *  sent). Saves as soon as it is toggled. */
export function AskPermissionField({ request }: { request: DiagnosisRequest }) {
  const { t } = useLingui();
  const { busy, error, save } = useEdit(request.id);

  return (
    <>
      <Row label={t`Ask them for permission`} htmlFor="diagnosis-request-ask-permission">
        <Checkbox
          id="diagnosis-request-ask-permission"
          checked={!!request.ask_permission}
          disabled={busy}
          onCheckedChange={(on) => void save({ ask_permission: on === true })}
          data-testid="diagnosis-request-ask-permission-field"
        />
      </Row>
      <ErrorLine error={error} />
    </>
  );
}

/** The window and the largest run: each saves as soon as it is picked. */
export function LimitsFields({ request }: { request: DiagnosisRequest }) {
  const { t } = useLingui();
  const { busy, error, save } = useEdit(request.id);
  const currentMb = String(Math.round((request.max_run_bytes ?? 2 * MB) / MB));
  const closed = !!request.write_expires_at && new Date(request.write_expires_at).getTime() < Date.now();
  const until = formatWhen(request.write_expires_at);

  return (
    <>
      <Row label={t`Accepts runs until`} htmlFor="diagnosis-request-write-hours">
        <div className="flex items-center gap-2">
          <span className={cn(closed && 'text-destructive')}>{closed ? t`${until} (closed)` : until}</span>
          <div className="w-56">
            <HoursSelect
              id="diagnosis-request-write-hours"
              value=""
              onChange={(hours) => void save({ write_hours: Number(hours) })}
              placeholder={closed ? t`Reopen for…` : t`Change to… from now`}
            />
          </div>
        </div>
      </Row>
      <Row label={t`Largest run`} htmlFor="diagnosis-request-max-mb">
        <div className="w-32">
          <Select
            value={currentMb}
            disabled={busy}
            onValueChange={(mb) => mb !== currentMb && void save({ max_run_mb: Number(mb) })}
          >
            <SelectTrigger id="diagnosis-request-max-mb" dir="ltr">
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
      </Row>
      <ErrorLine error={error} />
    </>
  );
}

/** The runner's LLM budget: the current one, and a form that funds a new one in its place. */
export function BudgetField({ request }: { request: DiagnosisRequest }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [budget, setBudget] = useState<Budget>(DEFAULT_BUDGET);
  const { busy, error, save } = useEdit(request.id);
  const current = request.llm_endpoint_typeid;

  const fund = async () => {
    if (await save({ funding: fundingBody(budget) })) {
      setOpen(false);
      setBudget(DEFAULT_BUDGET);
    }
  };

  return (
    <>
      <Row label={t`LLM budget`}>
        <div className="flex items-center gap-2">
          <span className={cn('min-w-0 break-all', current ? 'font-mono text-xs' : 'text-muted-foreground')}>
            {current || t`none — they use their own`}
          </span>
          {!open && (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="diagnosis-request-fund">
              {current ? <Trans>Replace</Trans> : <Trans>Pay for their LLM</Trans>}
            </Button>
          )}
        </div>
      </Row>
      {open && (
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-xs text-muted-foreground">
            {current ? (
              <Trans>The new budget takes over at once; the current one is closed. What was spent stays spent.</Trans>
            ) : (
              <Trans>
                For someone with no token source of their own. They spend it by the request id, up to the cap and until
                it expires.
              </Trans>
            )}
          </p>
          <BudgetFields budget={budget} onChange={setBudget} />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !budget.source}
              onClick={() => void fund()}
              data-testid="diagnosis-request-fund-save"
            >
              {busy ? <Trans>Saving…</Trans> : <Trans>Save budget</Trans>}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      )}
      <ErrorLine error={error} />
    </>
  );
}
