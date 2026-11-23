/**
 * The Upgrade screen — what a person sees when nothing can pay for the assistant any more because
 * their Flowpad budget is used up.
 *
 * **Opened by the bus, read from the funding record.** The backend announces
 * `agent.no_token_source` when a turn or a spawn is refused for want of a source (see
 * docs/flow-events.md). The event is only the signal: it re-reads the funding record, and for a
 * spent budget (`code: budget_used`) opens this screen. Everything shown — which budget, how much
 * it held — comes from that record and the hub's chain read, never from the event, so the chat's
 * own "out of tokens" card opens the same screen after a reload.
 *
 * **It closes by itself.** The funding read asks the hub whether a spent budget has money again;
 * once it does (an upgrade, a raised cap) or another source takes over, there is nothing to ask.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { dataContext, type FlowEvent, type LLMFundingStatus, type LLMSource, LLMSourceRefusal } from '@sdk';
import { useOnTag } from '@sdk/react/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { openHarnessLoginModal } from '@src/components/harness-login/harness-login-store';
import { formatUsd, usedRatio } from '@src/components/llm-endpoints/usage-math';
import { invalidateHubRemaining, useHubRemaining } from '@src/components/llm-sources/use-hub-remaining';
import { invalidateLlmFunding, useLlmSources } from '@src/components/llm-sources/use-llm-sources';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@src/components/ui/dialog';
import { Progress } from '@src/components/ui/progress';
import { openExternal } from '@src/lib/open-external';

import { closeUpgradeScreen as close, openUpgradeScreen, useUpgradeStore } from './upgrade-store';

export const NO_TOKEN_SOURCE_TAG = 'agent.no_token_source';
/** Where "Upgrade" goes: the public plans page. */
export const UPGRADE_URL = 'https://flowpad.ai/pricing';

/** The budget the hub refused a turn on, as the funding record names it; null when none is spent. */
export function spentBudget(status: LLMFundingStatus | null | undefined): LLMSource | null {
  for (const sources of Object.values(status?.sources ?? {})) {
    const spent = sources.find((source) => source.reason_code === LLMSourceRefusal.BudgetUsed);
    if (spent) return spent;
  }
  return null;
}

/** Mounted once at the app root: hears the event, and renders the screen while it is open. */
export function UpgradeScreenRoot() {
  const open = useUpgradeStore((s) => s.open);
  useOnTag(NO_TOKEN_SOURCE_TAG, (event: FlowEvent) => {
    invalidateLlmFunding();
    if ((event.data as { code?: string } | undefined)?.code === LLMSourceRefusal.BudgetUsed) openUpgradeScreen();
  });
  return open ? <UpgradeScreen /> : null;
}

function UpgradeScreen() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const { status } = useLlmSources();
  const spent = spentBudget(status);
  const cost = useHubRemaining(status, 'all')[spent?.endpoint_typeid ?? '']?.remaining;
  const [checking, setChecking] = useState(false);

  // Money is back or another source took over: close. Only after the spent budget was SEEN here —
  // the record this opened over may predate the refusal that opened it.
  const upgradeRef = useRef<HTMLButtonElement>(null);
  const seenSpent = useRef(false);
  useEffect(() => {
    if (spent) seenSpent.current = true;
    else if (seenSpent.current) close();
  }, [spent]);

  const checkAgain = async () => {
    setChecking(true);
    invalidateLlmFunding();
    await invalidateHubRemaining(queryClient);
    setChecking(false);
  };

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="upgrade-screen"
        // The way forward takes the focus, not whichever control happens to come first.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          upgradeRef.current?.focus();
        }}
      >
        <div className="flex flex-col items-center gap-4 pt-2 text-center">
          <span className="rounded-full bg-primary/10 p-3 text-primary">
            <Zap className="h-6 w-6" aria-hidden="true" />
          </span>
          <DialogTitle className="text-xl">
            <Trans>You're out of tokens</Trans>
          </DialogTitle>
          <DialogDescription className="max-w-sm">
            <Trans>
              Your Flowpad budget is used up, so the assistant has paused. Your work is saved — upgrade to pick up right
              where you left off.
            </Trans>
          </DialogDescription>

          {cost && (
            <div className="w-full rounded-lg border bg-muted/40 p-3 text-start" data-testid="upgrade-budget">
              <div className="mb-2 flex items-baseline justify-between gap-3 text-xs">
                <span className="truncate font-medium text-foreground">{spent?.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  <Trans>
                    {formatUsd(Math.min(cost.used, cost.limit))} of {formatUsd(cost.limit)} used
                  </Trans>
                </span>
              </div>
              <Progress value={usedRatio(cost) * 100} />
            </div>
          )}

          <div className="flex w-full flex-col gap-2">
            <Button
              ref={upgradeRef}
              size="lg"
              className="w-full"
              data-testid="upgrade-cta"
              onClick={() => openExternal(UPGRADE_URL)}
            >
              <Trans>Upgrade</Trans>
            </Button>
            {/* Assistants & keys live on a machine that runs harnesses; the hub page has none. */}
            {dataContext.caps.terminals && (
              <Button
                variant="outline"
                className="w-full"
                data-testid="upgrade-own-account"
                onClick={() => {
                  close();
                  openHarnessLoginModal();
                }}
              >
                <Trans>Use my own AI account</Trans>
              </Button>
            )}
          </div>

          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            disabled={checking}
            onClick={() => void checkAgain()}
            data-testid="upgrade-check-again"
          >
            {checking ? t`Checking…` : t`Already upgraded? Check again`}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
