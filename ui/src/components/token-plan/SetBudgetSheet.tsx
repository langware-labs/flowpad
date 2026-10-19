/**
 * The inline "Set budget" sheet: `LimitsEditor` for the scope endpoint's own
 * `limits` and, on team/org scopes, a second one for `member_default_limits`
 * (what the hub stamps on each member's default). Save is a plain entity
 * update — the same `dataManager.save` the endpoint dialog uses — then the
 * plan and endpoint queries are invalidated.
 *
 * Mount it only while open (`{sheetOpen && <SetBudgetSheet …/>}`): it resolves
 * the scope endpoint itself, so a closed sheet costs no request.
 */
import { dataManager, type LLMEndpoint, type TokenPlanScopeKind } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useMemo, useState } from 'react';

import { LimitsEditor } from '@src/components/llm-endpoints/LimitsEditor';
import { useLlmEndpoint } from '@src/components/llm-endpoints/use-llm-endpoints';
import {
  LIMIT_KEYS,
  badNonNegative,
  formToLimits,
  limitsToForm,
  type LimitsForm,
} from '@src/components/llm-endpoints/filters-limits-forms';
import { Button } from '@src/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@src/components/ui/sheet';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { useInvalidateTokenPlan } from './use-token-plan';

export interface SetBudgetSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The scope's endpoint — the hub's typeid or a bare uuid; the endpoint layer
   *  resolves it to the entity. */
  endpointId: string;
  scopeKind: TokenPlanScopeKind;
  scopeName: string;
}

export function SetBudgetSheet({ open, onOpenChange, endpointId, scopeKind, scopeName }: SetBudgetSheetProps) {
  const { t } = useLingui();
  // Mounted only while the sheet is open, so the endpoint list is fetched when
  // a budget is actually being edited — opening the plan screen costs nothing.
  const endpoint = useLlmEndpoint(endpointId);
  const invalidate = useInvalidateTokenPlan();
  const [limits, setLimits] = useState<LimitsForm>(() => limitsToForm(null));
  const [memberDefaults, setMemberDefaults] = useState<LimitsForm>(() => limitsToForm(null));
  const [busy, setBusy] = useState(false);
  const withMembers = scopeKind !== 'me';

  useEffect(() => {
    if (!open) return;
    setLimits(limitsToForm(endpoint?.limits));
    setMemberDefaults(limitsToForm(endpoint?.member_default_limits));
  }, [open, endpoint]);

  const bad = useMemo(
    () => [...badNonNegative(limits, LIMIT_KEYS), ...(withMembers ? badNonNegative(memberDefaults, LIMIT_KEYS) : [])],
    [limits, memberDefaults, withMembers],
  );

  const save = async () => {
    if (!endpoint || bad.length) return;
    setBusy(true);
    try {
      const json: Record<string, unknown> = { limits: formToLimits(limits) };
      if (withMembers) json.member_default_limits = formToLimits(memberDefaults);
      await dataManager.save<LLMEndpoint>(endpoint.typeId, [], json as never);
      await invalidate();
      notify.success({ title: t`Budget updated` });
      onOpenChange(false);
    } catch (e) {
      notify.error({ title: t`Could not save the budget`, message: errorMessage(e, '') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-xl" data-testid="set-budget-sheet">
        <SheetHeader>
          <SheetTitle>{t`Set budget · ${scopeName}`}</SheetTitle>
          <SheetDescription>
            <Trans>Empty means no limit. Windows are UTC days, weeks (Monday) and months.</Trans>
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-6">
          <div className="space-y-2">
            <h4 className="text-sm font-medium">
              {scopeKind === 'me' ? <Trans>Your budget</Trans> : <Trans>Budget for the whole scope</Trans>}
            </h4>
            <LimitsEditor value={limits} onChange={setLimits} disabled={busy || !endpoint} />
          </div>
          {withMembers && (
            <div className="space-y-2" data-testid="member-default-limits">
              <h4 className="text-sm font-medium">
                <Trans>Default budget per member</Trans>
              </h4>
              <p className="text-xs text-muted-foreground">
                <Trans>Applied to each member's own default endpoint; a member's budget can only be narrower.</Trans>
              </p>
              <LimitsEditor value={memberDefaults} onChange={setMemberDefaults} disabled={busy || !endpoint} />
            </div>
          )}
          {bad.length > 0 && (
            <p className="text-xs text-destructive" data-testid="budget-problems">
              <Trans>Limits must be non-negative numbers.</Trans>
            </p>
          )}
        </div>
        <SheetFooter className="mt-6">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void save()} disabled={busy || !endpoint || bad.length > 0} data-testid="budget-save">
            {busy ? '…' : t`Save`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
