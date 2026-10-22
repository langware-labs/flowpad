/**
 * Carve a budget out of a token source. What it can be given to follows who sponsors the source:
 *
 * * an **org pool** → a team that has no budget yet (the team's `setup-budget`, which draws the new
 *   team pool from the org pool), capped per month;
 * * a **team pool** → a person (the same two calls the team budget screen makes: `allocate` on the
 *   pool + share by email, then a team invite — `addPeopleToTeam`);
 * * **your own key** (or any other source you administer) → a capped sub-budget of yours
 *   (`allocate` with no grant).
 *
 * Every path is an existing hub flow; this dialog only picks which one.
 */
import { LLMEndpoint, TypeId, dataManager, llmEndpointsService, tokenPlanService, type TokenPlanScope } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';

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
import { Label } from '@src/components/ui/label';
import { endpointTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { addPeopleToTeam } from '@src/components/organization/budgets/add-people';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { costLeft, scopeForEndpoint, sponsorOf } from './source-tree';

type AllocateTarget = 'team' | 'member' | 'self';

/** What a source of this sponsor is allocated to: org pool → a team, own team pool → a member,
 *  anything else → a sub-budget of the caller's. */
function targetFor(source: LLMEndpoint, ownTeamScope: TokenPlanScope | undefined): AllocateTarget {
  const sponsor = sponsorOf(source);
  if (sponsor === 'org') return 'team';
  if (sponsor === 'team' && ownTeamScope) return 'member';
  return 'self';
}

export function AllocateDialog({
  source,
  scopes,
  onClose,
  onDone,
}: {
  source: LLMEndpoint;
  /** The caller's token plan scopes: teams without a budget, and the team a pool belongs to. */
  scopes: readonly TokenPlanScope[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const sourceTypeId = endpointTypeId(source.id);
  const ownScope = scopeForEndpoint(scopes, source.id);
  const ownTeamScope = ownScope?.kind === 'team' ? ownScope : undefined;
  const target = targetFor(source, ownTeamScope);
  const budgetless = scopes.filter((s) => s.kind === 'team' && !s.endpoint_id && s.can_configure);
  const [teamId, setTeamId] = useState(budgetless[0]?.id ?? '');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const left = costLeft(source);
  const usd = Number(limit);
  const valid =
    usd > 0 && (target === 'team' ? !!teamId : target === 'member' ? /.+@.+/.test(email) : name.trim().length > 0);

  const submit = async () => {
    setBusy(true);
    try {
      if (target === 'team') {
        const created = await tokenPlanService.setupTeam(teamId);
        await dataManager.save<LLMEndpoint>(new TypeId(created.endpoint_id), [], {
          limits: { cost_usd_per_month: usd },
        } as never);
      } else if (target === 'member' && ownTeamScope) {
        const outcome = await addPeopleToTeam(
          sourceTypeId,
          ownTeamScope.id,
          [{ name: name.trim() || email.trim(), email: email.trim().toLowerCase(), budget: usd }],
          [],
        );
        if (outcome.failed.length) throw new Error(outcome.failed[0].reason);
      } else {
        await llmEndpointsService.allocate(source.id, {
          name: name.trim(),
          limits: { cost_usd_total: usd } as never,
        });
      }
      notify.success({ title: t`Budget allocated from ${source.name}` });
      onDone();
      onClose();
    } catch (e) {
      notify.error({ title: t`Could not allocate`, message: errorMessage(e, '') });
    } finally {
      setBusy(false);
    }
  };

  const forText: Record<AllocateTarget, string> = {
    team: t`A team without a budget gets its own pool, drawn from this one.`,
    member: t`One person's allowance on this team.`,
    self: t`A capped sub-budget of yours, for an agent or app.`,
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="allocate-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Allocate from {source.name}</Trans>
          </DialogTitle>
          <DialogDescription>
            {left ? (
              <Trans>
                {formatUsd(left.remaining)} left of {formatUsd(left.limit)}.
              </Trans>
            ) : (
              <Trans>This source has no cost limit of its own.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm" data-testid={`allocate-target-${target}`}>
            {forText[target]}
          </p>
          {target === 'team' && (
            <div className="space-y-1">
              <Label htmlFor="allocate-team">
                <Trans>Team</Trans>
              </Label>
              {budgetless.length ? (
                <select
                  id="allocate-team"
                  data-testid="allocate-team"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                >
                  {budgetless.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  <Trans>Every team you manage already has a budget.</Trans>
                </p>
              )}
            </div>
          )}
          {target === 'member' && (
            <div className="space-y-1">
              <Label htmlFor="allocate-email">
                <Trans>Email</Trans>
              </Label>
              <Input
                id="allocate-email"
                data-testid="allocate-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          )}
          {target !== 'team' && (
            <div className="space-y-1">
              <Label htmlFor="allocate-name">
                <Trans>Name</Trans>
              </Label>
              <Input
                id="allocate-name"
                data-testid="allocate-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="allocate-limit">
              {target === 'team' ? <Trans>Limit (USD per month)</Trans> : <Trans>Limit (USD, total)</Trans>}
            </Label>
            <Input
              id="allocate-limit"
              data-testid="allocate-limit"
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
            {left && (
              <p className="text-xs text-muted-foreground">
                <Trans>At most {formatUsd(left.remaining)} — what this source has left.</Trans>
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            <Trans>Models and filters are inherited from the source and can only be narrowed.</Trans>
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || busy} data-testid="allocate-submit">
            <Trans>Allocate</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
