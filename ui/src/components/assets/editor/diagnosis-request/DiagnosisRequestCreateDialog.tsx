/**
 * New diagnosis request: what the other person's agent is asked to do, what it gets sent along,
 * how long the request accepts runs, and -- optionally -- an LLM budget the runner spends by the
 * request's id. The Create panel's bespoke dialog for the type (the generic form only asks for a
 * name); on success it opens the request, whose screen shows the command to send.
 */
import { DiagnosisRequest, TypeId, type AssetDescriptor } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import React, { useEffect, useState } from 'react';

import { Button } from '@src/components/ui/button';
import { AssetRefChips, AttachMenu } from '@src/components/conversation/AttachMenu';
import { FileAttachmentPicker, mergePickedFiles } from '@src/components/conversation/FileAttachmentPicker';
import { Checkbox } from '@src/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@src/components/ui/select';
import { Textarea } from '@src/components/ui/textarea';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

import {
  callRequestAction,
  errorText,
  openRequest,
  readFile,
  type FundingSources,
  type OpenRequestBody,
} from './diagnosis-request-api';
import { ErrorLine } from './ErrorLine';

const HOURS = ['24', '48', '72', '168'] as const;
export const MAX_RUN_MB = ['2', '5', '10'] as const;
/** The asset types a request may send along -- the backend's ``ATTACHABLE_ASSET_TYPES``. */
const ATTACHABLE_TYPES = ['skill', 'subagent', 'markdown', 'prompt'];
export const isAttachable = (d: AssetDescriptor) => ATTACHABLE_TYPES.some((type) => d.typeid.startsWith(`${type}-`));

export function HoursSelect({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  /** Shown while `value` is empty -- the edit dialog's "keep it as it is". */
  placeholder?: string;
}) {
  const { t } = useLingui();
  const labels: Record<(typeof HOURS)[number], string> = {
    '24': t`24 hours`,
    '48': t`48 hours`,
    '72': t`3 days`,
    '168': t`7 days`,
  };
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {HOURS.map((h) => (
          <SelectItem key={h} value={h}>
            {labels[h]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Where the budget comes from: `hub:<typeid>` or `key:<provider>`. */
function FundingFields({
  sources,
  loadError,
  source,
  onSource,
}: {
  sources: FundingSources | null;
  loadError: string | null;
  source: string;
  onSource: (v: string) => void;
}) {
  const { t } = useLingui();
  const usable = sources?.hub.filter((s) => s.can_allocate) ?? [];
  const blocked = sources?.hub.filter((s) => !s.can_allocate) ?? [];
  const keys = sources?.local_keys ?? [];
  const managers = [...new Set(blocked.map((s) => s.manager).filter(Boolean))].join(', ');

  if (loadError) return <ErrorLine error={t`Could not list budgets: ${loadError}`} />;
  if (!sources) {
    return (
      <p className="text-xs text-muted-foreground">
        <Trans>Loading…</Trans>
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor="diagnosis-source">
        <Trans>Budget source</Trans>
      </Label>
      <Select value={source} onValueChange={onSource}>
        <SelectTrigger id="diagnosis-source" data-testid="diagnosis-request-source">
          <SelectValue placeholder={t`No budget you can hand out`} />
        </SelectTrigger>
        <SelectContent>
          {usable.length > 0 && (
            <SelectGroup>
              <SelectLabel>
                <Trans>Hub budgets you can hand out</Trans>
              </SelectLabel>
              {usable.map((s) => (
                <SelectItem key={s.typeid} value={`hub:${s.typeid}`}>
                  {s.name} ({s.provider})
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {keys.length > 0 && (
            <SelectGroup>
              <SelectLabel>
                <Trans>Keys on this computer</Trans>
              </SelectLabel>
              {keys.map((k) => (
                <SelectItem key={k.provider} value={`key:${k.provider}`}>
                  {t`${k.provider} key`}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {blocked.length > 0 && (
            <SelectGroup>
              <SelectLabel>
                <Trans>Budgets you can only spend</Trans>
              </SelectLabel>
              {blocked.map((s) => {
                const manager = s.manager || t`its manager`;
                return (
                  <SelectItem key={s.typeid} value={`blocked:${s.typeid}`} disabled>
                    {t`${s.name} — ask ${manager}`}
                  </SelectItem>
                );
              })}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      {source.startsWith('key:') && (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="diagnosis-request-key-warning">
          <Trans>
            This key will be uploaded to the Flowpad hub and used on the other person's computer — up to the cap and
            until it expires. They never see the key itself.
          </Trans>
        </p>
      )}
      {!source && (
        <p className="text-xs text-muted-foreground">
          <Trans>You have no budget you can hand out.</Trans>{' '}
          {managers && (
            <Trans>
              Ask {managers} — who manages the budget you were given — to make you its admin, or to give you a budget of
              your own.
            </Trans>
          )}{' '}
          <Trans>You can also add an LLM key in LLM Sources.</Trans>
        </p>
      )}
    </div>
  );
}

/** The "pay for their LLM" choices: where from (`hub:<typeid>` / `key:<provider>`), the cap, the life, the model. */
export interface Budget {
  source: string;
  cap: string;
  hours: string;
  model: string;
}

export const DEFAULT_BUDGET: Budget = { source: '', cap: '1', hours: '48', model: '' };

/** `DiagnosisFundingSpec` from the owner's choices. */
export function fundingBody(budget: Budget): NonNullable<OpenRequestBody['funding']> {
  const [kind, ref] = budget.source.split(/:(.*)/s);
  return {
    cost_usd_total: Number(budget.cap),
    hours: Number(budget.hours),
    model: budget.model.trim(),
    ...(kind === 'key' ? { local_key_provider: ref } : { source_typeid: ref }),
  };
}

/** Source, cap, expiry and model of a budget. The sources are the hub's answer, asked on mount --
 *  render this only once the owner wants to pay. Picks the first usable source when none is set. */
export function BudgetFields({ budget, onChange }: { budget: Budget; onChange: (next: Budget) => void }) {
  const [sources, setSources] = useState<FundingSources | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const set = (patch: Partial<Budget>) => onChange({ ...budget, ...patch });

  useEffect(() => {
    callRequestAction<FundingSources>('funding_sources')
      .then((loaded) => {
        setSources(loaded);
        if (budget.source) return;
        const first = loaded.hub.find((s) => s.can_allocate);
        const source = first
          ? `hub:${first.typeid}`
          : loaded.local_keys[0]
            ? `key:${loaded.local_keys[0].provider}`
            : '';
        onChange({ ...budget, source });
      })
      .catch((e: unknown) => setSourcesError(errorText(e)));
    // Asked once per mount: the budget the owner edits afterwards must not re-ask the hub.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-3">
      <FundingFields
        sources={sources}
        loadError={sourcesError}
        source={budget.source}
        onSource={(source) => set({ source })}
      />
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="diagnosis-cap">
            <Trans>Cap (USD)</Trans>
          </Label>
          <Input
            id="diagnosis-cap"
            type="number"
            min="0.1"
            step="0.1"
            dir="ltr"
            value={budget.cap}
            onChange={(e) => set({ cap: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="diagnosis-fund-hours">
            <Trans>Expires after</Trans>
          </Label>
          <HoursSelect id="diagnosis-fund-hours" value={budget.hours} onChange={(hours) => set({ hours })} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="diagnosis-model">
          <Trans>Model</Trans>{' '}
          <span className="text-xs font-normal text-muted-foreground">
            <Trans>— optional; pins every call to it</Trans>
          </span>
        </Label>
        <Input
          id="diagnosis-model"
          className="font-mono"
          dir="ltr"
          value={budget.model}
          placeholder="anthropic/claude-haiku-4.5"
          onChange={(e) => set({ model: e.target.value })}
        />
      </div>
    </div>
  );
}

export const DiagnosisRequestCreateDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string | null;
}> = ({ open, onOpenChange, projectId = null }) => {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [instructions, setInstructions] = useState('');
  // Off by default: `flow diagnose <id>` runs every step and always sends, asking nothing.
  const [askPermission, setAskPermission] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [assetRefs, setAssetRefs] = useState<AssetDescriptor[]>([]);
  const [writeHours, setWriteHours] = useState('48');
  const [maxRunMb, setMaxRunMb] = useState('2');
  const [fund, setFund] = useState(false);
  const [budget, setBudget] = useState<Budget>(DEFAULT_BUDGET);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setInstructions('');
    setAskPermission(false);
    setFiles([]);
    setAssetRefs([]);
    setFund(false);
    setBudget(DEFAULT_BUDGET);
    setError(null);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: OpenRequestBody = {
        instructions: instructions.trim(),
        ask_permission: askPermission,
        project_id: projectId ?? '',
        write_hours: Number(writeHours),
        max_run_mb: Number(maxRunMb),
        attachments: [
          ...(await Promise.all(files.map(readFile))),
          ...assetRefs.map((a) => ({ asset_typeid: a.typeid })),
        ],
      };
      if (fund) body.funding = fundingBody(budget);
      const { request } = await openRequest(body);
      onOpenChange(false);
      reset();
      notify.success({ title: t`Diagnosis request created` });
      navigation.openDock(
        DockPointer.forAssetEditorByTypeId(DiagnosisRequest.type, new TypeId(DiagnosisRequest.type, request.id)),
      );
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
            <Trans>New diagnosis request</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="diagnosis-instructions">
              <Trans>Instructions for their agent</Trans>{' '}
              <span className="text-xs font-normal text-muted-foreground">
                <Trans>— one step per line, optional</Trans>
              </span>
            </Label>
            <Textarea
              id="diagnosis-instructions"
              autoFocus
              rows={5}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              data-testid="diagnosis-request-instructions"
            />
          </div>

          <div className="space-y-1">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={askPermission}
                onCheckedChange={(on) => setAskPermission(on === true)}
                data-testid="diagnosis-request-ask-permission"
              />
              <Trans>Ask them for permission</Trans>
            </label>
            <p className="text-xs text-muted-foreground">
              {askPermission ? (
                <Trans>
                  They approve the steps and what you sent along, describe the issue, and decide whether the result is
                  sent to you.
                </Trans>
              ) : (
                <Trans>Nothing is asked: every step runs, and the result is always sent to you.</Trans>
              )}
            </p>
          </div>

          {/* The same Attach button a message has: files from this computer, or Flowpad assets. */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label>
                <Trans>Send along</Trans>{' '}
                <span className="text-xs font-normal text-muted-foreground">
                  <Trans>— for this run only, optional</Trans>
                </span>
              </Label>
              <AttachMenu
                assetRefs={assetRefs}
                onAssetRefsChange={setAssetRefs}
                onFilesPicked={(picked) => setFiles((prev) => mergePickedFiles(prev, picked).files)}
                disabled={busy}
                hideAssetList
                assetFilter={isAttachable}
              />
            </div>
            <AssetRefChips assetRefs={assetRefs} onChange={setAssetRefs} disabled={busy} />
            <FileAttachmentPicker files={files} onChange={setFiles} disabled={busy} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="diagnosis-write-hours">
                <Trans>Accepts runs for</Trans>
              </Label>
              <HoursSelect id="diagnosis-write-hours" value={writeHours} onChange={setWriteHours} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="diagnosis-max-mb">
                <Trans>Largest run</Trans>
              </Label>
              <Select value={maxRunMb} onValueChange={setMaxRunMb}>
                <SelectTrigger id="diagnosis-max-mb" dir="ltr">
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
                  data-testid="diagnosis-request-fund"
                />
                <Trans>Pay for their LLM</Trans>
              </label>
            </legend>
            <p className="text-xs text-muted-foreground">
              <Trans>
                For someone with no token source of their own. They spend it by the request id, up to the cap and until
                it expires.
              </Trans>
            </p>
            {fund && <BudgetFields budget={budget} onChange={setBudget} />}
          </fieldset>

          <ErrorLine error={error} testId="diagnosis-request-error" />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={busy || (fund && !budget.source)}
            onClick={() => void create()}
            data-testid="diagnosis-request-create"
          >
            {busy ? <Trans>Creating…</Trans> : <Trans>Create request</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
