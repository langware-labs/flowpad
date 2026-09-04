/**
 * The org → team → person budget hierarchy, as one continuous page: an organization's own
 * budget at the top, its teams indented beneath it, and each team's people indented beneath
 * that. Nothing here is a separate screen reached by selecting a tree node — every level is on
 * the page at once, name and total editable in place, a delete icon beside every row.
 *
 * The plain version of `/dock/hub/llm-endpoints`. That screen is about provider keys, fallback
 * chains and nine limit fields per hop; this one answers the only question a paying customer's
 * admin has — how much has each team and each person got, and how much is left.
 *
 * **Two things collapse, for different reasons.** The org's key form (`OrgRootSetup`) starts open
 * only while the org has no pool at all, and closed once a root exists — it is somewhere you go,
 * not something you read every visit. A team's people list stays closed until opened OR "Add
 * people" is pressed, and that one is load-bearing: a person costs a spend read each, so showing
 * every team's roster on first paint would turn "open the page" into a per-person fan-out across
 * every team at once.
 *
 * **Everything else about an endpoint is behind "Advanced".** Each row carries the four controls
 * that answer the page's question — name, total, enabled, allowed models — and an `AdvancedButton`
 * for the twenty-odd knobs that do not (per-window ceilings, rate caps, path and beta lists, alias
 * maps). Putting those on the row would bury the four that matter.
 *
 * **Over-promising is shown, not blocked.** A pool may hand out more than it holds; the hub
 * catches the excess when the money is SPENT, along the whole chain, not when it is promised. So
 * a total that exceeds the pool is rendered as a plain warning line rather than a refused edit.
 */
import { TypeId, dataManager, type MemberBudget, type ScopeBudget } from '@sdk';
import { ChevronDown, ChevronRight, Hash, Loader2, Pencil, Trash2, UserPlus, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { InlineRenameInput } from '@src/components/browseable-tree/InlineRenameInput';
import { useInlineRename } from '@src/components/browseable-tree/use-inline-rename';
import { formatValue } from '@src/components/cost-dashboard/constants';
import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { useSetupScope } from '@src/components/token-plan/use-token-plan';
import { useCreateChildTeamForm } from '@src/components/organization/use-create-child-team';
import { Button } from '@src/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@src/components/ui/collapsible';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { AddPeopleDialog } from './AddPeopleDialog';
import { AdvancedButton } from './AdvancedEndpointDialog';
import { EditableTitle } from './EditableTitle';
import { EndpointControls } from './EndpointControls';
import { MoneyBox } from './MoneyBox';
import { OrgRootSetup } from './OrgRootSetup';
import {
  useInvalidateBudgets,
  useOrgBudgets,
  useRemoveAllowance,
  useSetLifetimeCap,
  useTeamBudgets,
} from './use-budgets';

async function renameEntity(type: 'organization' | 'team', id: string, next: string): Promise<void> {
  await dataManager.save(new TypeId(type, id), [], { name: next } as never);
}

/** Tokens spent, next to the dollar figure. NOT `Zap` — `TestEndpointButton` (right next to this
 *  on every one of these rows) already owns that glyph for "run a test call", so reusing it here
 *  would put two different meanings under one shape on the same row. `Hash` is unclaimed on this
 *  page. The word "tokens" moves into the tooltip instead of sitting in the row as text. */
function TokenCount({ tokens, testIdPrefix }: { tokens: number; testIdPrefix?: string }) {
  const { t } = useLingui();
  return (
    <span
      className="inline-flex items-center gap-1"
      title={t`Tokens spent`}
      data-testid={testIdPrefix ? `${testIdPrefix}-tokens` : undefined}
    >
      <Hash className="h-3 w-3 text-purple-500" aria-hidden="true" />
      {formatValue(tokens, 'tokens')}
    </span>
  );
}

// ── organization ──────────────────────────────────────────────────────────────

export function OrgUnit({ orgId, onDeleted }: { orgId: string; onDeleted: () => void }) {
  const { t } = useLingui();
  const { data, isLoading, error } = useOrgBudgets(orgId);
  const setCap = useSetLifetimeCap();
  const invalidate = useInvalidateBudgets();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(null); // null = "not touched yet"
  const createTeam = useCreateChildTeamForm({
    parentTypeId: new TypeId('organization', orgId),
    parentLabel: data?.org.name ?? '',
    isOrganization: true,
    organizationCreatedTitle: t`Team created`,
    onCreated: () => void invalidate(),
  });

  if (error) return <Denied />;
  if (isLoading || !data) return <Loading />;

  const org = data.org;
  const over = org.limit_usd !== null && org.allocated_usd !== null && org.allocated_usd > org.limit_usd;
  // Opens on its own only while there is NO POOL AT ALL — a fresh org needs the key form in front
  // of it. Once a root exists the form is a thing you go to, not a thing you read every visit, so it
  // starts closed. Either way the admin's own toggle wins from the first click.
  const settingsExpanded = settingsOpen ?? !org.endpoint_id;

  const remove = async () => {
    setDeleting(true);
    try {
      await dataManager.delete(new TypeId('organization', orgId));
      onDeleted();
    } catch (e) {
      notify.error({ title: t`Could not delete ${org.name}`, message: errorMessage(e, ''), id: 'org-delete' });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="rounded-lg border border-border" data-testid="org-unit">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <EditableTitle
          name={org.name}
          onRename={async (next) => {
            await renameEntity('organization', orgId, next);
            await invalidate();
          }}
          onDelete={() => setConfirmDelete(true)}
          deleting={deleting}
          headingClassName="text-lg font-semibold"
          testIdPrefix="org"
        />
        {org.endpoint_id && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">
                <Trans>Total</Trans>
              </span>
              <MoneyBox
                value={org.limit_usd}
                ariaLabel={t`Total budget for ${org.name}`}
                data-testid="org-total-cap"
                disabled={setCap.isPending}
                onCommit={(usd) => setCap.mutate({ endpointId: org.endpoint_id as string, usd })}
              />
            </label>
            <span className="text-muted-foreground">
              <Trans>Spent</Trans>{' '}
              <span className="inline-flex items-center gap-1.5 font-medium tabular-nums text-foreground">
                {formatUsd(org.spent_usd)}
                <TokenCount tokens={org.spent_tokens ?? 0} testIdPrefix="org-spent" />
              </span>
            </span>
            {org.allocated_usd !== null && (
              <span className="text-muted-foreground" data-testid="org-allocated">
                <Trans>Given out to teams</Trans>{' '}
                <span className={`font-medium tabular-nums ${over ? 'text-destructive' : 'text-foreground'}`}>
                  {formatUsd(org.allocated_usd)}
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      {org.endpoint_id && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
          <EndpointControls endpointId={org.endpoint_id} testIdPrefix="org" />
          <AdvancedButton endpointId={org.endpoint_id} scopeLabel={org.name} testId="org-advanced" />
        </div>
      )}

      <div className="px-4 py-3">
        <Collapsible open={settingsExpanded} onOpenChange={setSettingsOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1 px-1.5" data-testid="org-settings-toggle">
              {settingsExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <Wallet className="h-3.5 w-3.5" />
              <Trans>Budget settings</Trans>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <OrgRootSetup orgId={orgId} org={org} />
          </CollapsibleContent>
        </Collapsible>
        {over && (
          <p className="mt-2 text-xs text-destructive" data-testid="org-over-allocated">
            <Trans>
              More has been given out than this budget holds. Nothing is blocked — whoever spends last will be refused
              once the money runs out.
            </Trans>
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-border py-3 pl-10 pr-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Trans>Teams</Trans>
        </div>
        {data.teams.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No teams yet.</Trans>
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {data.teams.map((team) => (
              <TeamUnit key={team.id} team={team} onChanged={() => void invalidate()} />
            ))}
          </div>
        )}
        {createTeam.open ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={createTeam.name}
              onChange={(e) => createTeam.setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createTeam.submit();
                if (e.key === 'Escape') createTeam.setOpen(false);
              }}
              placeholder={t`Team name…`}
              data-testid="org-create-team-name"
              className="w-44 rounded-md border border-border bg-background px-2.5 py-1 text-sm"
            />
            <Button
              size="sm"
              disabled={createTeam.busy || !createTeam.name.trim()}
              onClick={() => void createTeam.submit()}
              data-testid="org-create-team-submit"
            >
              {createTeam.busy && <Loader2 className="h-4 w-4 animate-spin" />}
              <Trans>Create</Trans>
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            data-testid="org-create-team"
            onClick={() => createTeam.setOpen(true)}
          >
            <Trans>New team</Trans>
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        variant="destructive"
        title={t`Delete ${org.name}?`}
        description={t`Every team and budget inside ${org.name} is deleted with it. This cannot be undone.`}
        confirmLabel={t`Delete`}
        onConfirm={() => {
          setConfirmDelete(false);
          void remove();
        }}
      />
    </section>
  );
}

/**
 * One person's budget. A component rather than inline JSX because it renames in place, and
 * `useInlineRename` is a hook — a hook inside the `.map` callback that used to render this row
 * would break the rules of hooks the moment the roster reorders.
 *
 * The three trailing controls read right-to-left in order of consequence: Advanced (tune it), Edit
 * (rename it), Delete (remove it). Delete keeps the rightmost, most-isolated slot it already had.
 *
 * **What Edit renames is the ENDPOINT, not the person.** `MemberBudget.name` is the endpoint's own
 * name — what the owner typed when adding them — falling back to the account name only when that
 * is empty. So this writes the same `name` field `renameEntity` writes for an org or a team, and
 * never touches the user's account.
 */
function MemberRow({
  member,
  capPending,
  onSetCap,
  onRemove,
}: {
  member: MemberBudget;
  capPending: boolean;
  onSetCap: (usd: number | null) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const invalidate = useInvalidateBudgets();
  const rename = useInlineRename(member.name, async (next) => {
    // `endpoint_id` is the PREFIXED typeid, which the single-argument `TypeId` parses — the same
    // form `setLifetimeCap` takes. Do not hand it to a two-argument `TypeId`.
    await dataManager.save(new TypeId(member.endpoint_id), [], { name: next } as never);
    await invalidate();
  });

  return (
    <TableRow data-testid={`member-budget-${member.endpoint_id}`}>
      <TableCell>
        {rename.editing ? (
          <InlineRenameInput
            rename={rename}
            className="rounded-md border border-border bg-background px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            testId={`member-rename-input-${member.endpoint_id}`}
            ariaLabel={t`Name`}
          />
        ) : (
          member.name
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">{member.email ?? '—'}</TableCell>
      <TableCell className="text-end">
        <MoneyBox
          value={member.limit_usd}
          ariaLabel={t`Budget for ${member.name}`}
          data-testid={`member-cap-${member.endpoint_id}`}
          disabled={capPending}
          onCommit={onSetCap}
        />
      </TableCell>
      <TableCell className="text-end tabular-nums">{formatUsd(member.spent_usd)}</TableCell>
      <TableCell className="text-end tabular-nums">
        <TokenCount tokens={member.spent_tokens ?? 0} testIdPrefix={`member-spent-${member.endpoint_id}`} />
      </TableCell>
      <TableCell>
        <EndpointControls endpointId={member.endpoint_id} testIdPrefix={`member-${member.endpoint_id}`} />
      </TableCell>
      <TableCell className="text-end">
        <div className="flex items-center justify-end gap-1">
          <AdvancedButton
            endpointId={member.endpoint_id}
            scopeLabel={member.name}
            testId={`member-advanced-${member.endpoint_id}`}
            iconOnly
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 shrink-0 text-muted-foreground"
            aria-label={t`Edit`}
            title={t`Rename this budget`}
            data-testid={`member-edit-${member.endpoint_id}`}
            onClick={rename.startEditing}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          {/* The hub mints its own per-user default again on that person's next read, so removing
              one achieves nothing but a confusing reappearance. */}
          {!member.system_default && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={t`Delete`}
              data-testid={`member-remove-${member.endpoint_id}`}
              onClick={onRemove}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

// ── team ──────────────────────────────────────────────────────────────────────

/** `team` is the org's own summary of it (name, total, spent) — cheap, always known, so the row
 *  renders fully before anything about its PEOPLE is ever fetched. */
function TeamUnit({ team, onChanged }: { team: ScopeBudget; onChanged: () => void }) {
  const { t } = useLingui();
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removingMember, setRemovingMember] = useState<MemberBudget | null>(null);
  // Fetched only once the people list is actually looked at or "Add people" is opened — the
  // per-person spend read this call carries must not fire for every team on page load.
  const detail = useTeamBudgets(peopleOpen || adding ? team.id : null);
  const setCap = useSetLifetimeCap();
  const remove = useRemoveAllowance();

  const poolId = team.endpoint_id;
  const over = team.limit_usd !== null && team.allocated_usd !== null && team.allocated_usd > team.limit_usd;

  const removeTeam = async () => {
    setDeleting(true);
    try {
      await dataManager.delete(new TypeId('team', team.id));
      onChanged();
    } catch (e) {
      notify.error({ title: t`Could not delete ${team.name}`, message: errorMessage(e, ''), id: 'team-delete' });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="rounded-md border border-border" data-testid={`team-unit-${team.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
        <EditableTitle
          name={team.name}
          onRename={async (next) => {
            await renameEntity('team', team.id, next);
            onChanged();
          }}
          onDelete={() => setConfirmDelete(true)}
          deleting={deleting}
          headingClassName="text-sm font-semibold"
          testIdPrefix={`team-${team.id}`}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {poolId ? (
            <>
              <label className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  <Trans>Total</Trans>
                </span>
                <MoneyBox
                  value={team.limit_usd}
                  ariaLabel={t`Budget for ${team.name}`}
                  data-testid={`team-cap-${team.id}`}
                  disabled={setCap.isPending}
                  onCommit={(usd) => setCap.mutate({ endpointId: poolId, usd }, { onSuccess: onChanged })}
                />
              </label>
              <span className="text-muted-foreground">
                <Trans>Spent</Trans>{' '}
                <span className="inline-flex items-center gap-1.5 font-medium tabular-nums text-foreground">
                  {formatUsd(team.spent_usd)}
                  <TokenCount tokens={team.spent_tokens ?? 0} testIdPrefix={`team-spent-${team.id}`} />
                </span>
              </span>
              <Button size="sm" data-testid={`team-add-people-${team.id}`} onClick={() => setAdding(true)}>
                <UserPlus className="h-4 w-4" />
                <Trans>Add people</Trans>
              </Button>
            </>
          ) : (
            <SetUpButton kind="team" scopeId={team.id} label={team.name} onDone={onChanged} />
          )}
        </div>
      </div>

      {over && (
        <p className="px-3 pb-2 text-xs text-destructive" data-testid={`team-over-allocated-${team.id}`}>
          <Trans>
            More has been given out than this budget holds. Nothing is blocked — whoever spends last will be refused
            once the money runs out.
          </Trans>
        </p>
      )}

      {poolId && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2">
          <EndpointControls endpointId={poolId} testIdPrefix={`team-${team.id}`} />
          <AdvancedButton endpointId={poolId} scopeLabel={team.name} testId={`team-advanced-${team.id}`} />
        </div>
      )}

      {poolId && (
        <div className="border-t border-border py-2 pl-10 pr-3">
          <Collapsible open={peopleOpen} onOpenChange={setPeopleOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1 px-1.5" data-testid={`team-people-toggle-${team.id}`}>
                {peopleOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                <Trans>People</Trans>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              {detail.isLoading || !detail.data ? (
                <Loading />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        <Trans>Name</Trans>
                      </TableHead>
                      <TableHead>
                        <Trans>Email</Trans>
                      </TableHead>
                      <TableHead className="text-end">
                        <Trans>Budget</Trans>
                      </TableHead>
                      <TableHead className="text-end">
                        <Trans>Spent</Trans>
                      </TableHead>
                      <TableHead className="text-end" title={t`Tokens spent`}>
                        <Hash className="ml-auto h-3.5 w-3.5 text-purple-500" aria-hidden="true" />
                      </TableHead>
                      <TableHead>
                        <Trans>Model / status</Trans>
                      </TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.data.members.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="py-4 text-center text-sm text-muted-foreground">
                          <Trans>Nobody has a budget in this team yet.</Trans>
                        </TableCell>
                      </TableRow>
                    )}
                    {detail.data.members.map((member) => (
                      <MemberRow
                        key={member.endpoint_id}
                        member={member}
                        capPending={setCap.isPending}
                        onSetCap={(usd) => setCap.mutate({ endpointId: member.endpoint_id, usd })}
                        onRemove={() => setRemovingMember(member)}
                      />
                    ))}
                  </TableBody>
                </Table>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}

      {poolId && adding && detail.data && (
        <AddPeopleDialog
          open
          onOpenChange={setAdding}
          poolId={poolId}
          teamName={team.name}
          existing={detail.data.members}
        />
      )}

      <ConfirmDialog
        open={!!removingMember}
        onOpenChange={(next) => !next && setRemovingMember(null)}
        variant="destructive"
        title={t`Remove this budget?`}
        description={t`${removingMember?.name ?? ''} will no longer be able to spend from ${team.name}. Money already spent is not affected.`}
        confirmLabel={t`Remove`}
        onConfirm={() => {
          if (!removingMember) return;
          const target = removingMember;
          setRemovingMember(null);
          remove.mutate(
            { endpointId: target.endpoint_id },
            {
              onError: (e) =>
                notify.error({
                  title: t`Could not remove ${target.name}`,
                  message: errorMessage(e, ''),
                  id: 'budget-remove',
                }),
            },
          );
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        variant="destructive"
        title={t`Delete ${team.name}?`}
        description={t`Everyone's budget inside ${team.name} is deleted with it. This cannot be undone.`}
        confirmLabel={t`Delete`}
        onConfirm={() => {
          setConfirmDelete(false);
          void removeTeam();
        }}
      />
    </section>
  );
}

// ── shared pieces ─────────────────────────────────────────────────────────────

function SetUpButton({
  kind,
  scopeId,
  label,
  onDone,
}: {
  kind: 'org' | 'team';
  scopeId: string;
  label: string;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const setup = useSetupScope();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={setup.isPending}
      data-testid={`budget-setup-${kind}-${scopeId}`}
      onClick={() =>
        setup.mutate(
          { kind, id: scopeId },
          {
            onSuccess: () => {
              notify.success({ title: t`Budget created for ${label}`, id: 'budget-setup' });
              onDone();
            },
            onError: (e) =>
              notify.error({ title: t`Could not create the budget`, message: errorMessage(e, ''), id: 'budget-setup' }),
          },
        )
      }
    >
      {setup.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
      <Trans>Set up budget</Trans>
    </Button>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <Trans>Loading budgets…</Trans>
    </div>
  );
}

/** The hub refuses the read outright below admin, so there is nothing to show and nothing to retry. */
function Denied() {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
      <Trans>Only an admin of this organization can see its budgets.</Trans>
    </div>
  );
}
