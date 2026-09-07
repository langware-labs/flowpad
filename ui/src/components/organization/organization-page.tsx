import { Organization, PageId, QueryRequest, ViewType, WorldViewProjection } from '@sdk';
import { Building2, GitGraph, Loader2, Plus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { Button } from '@src/components/ui/button';
import { useEntitiesQuery } from '@src/hooks/entity-hooks/useEntitiesQuery';
import { useMembershipAvailability } from '@src/hooks/use-membership-availability';
import { OrgUnit } from '@src/components/organization/budgets/BudgetSection';
import { createOrganization } from '@src/components/organization/create-organization';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

/**
 * People and teams — the plain screen.
 *
 * One continuous, full-width column: every organization the caller administers, each with its
 * own budget at the top, its teams indented beneath it, and each team's people indented beneath
 * that. Nothing here is reached by selecting a node in a side tree — everything is on the page,
 * name and amount editable in place, a delete icon beside every row. `OrgUnit`
 * (`components/organization/budgets`) owns that whole nested rendering; this page is just the
 * list of organizations and the "create one" control.
 *
 * The Organization WorldView shows the SAME data as a force-directed graph — the advanced view,
 * excellent for seeing shape and reach at a glance, wrong as the place you go to add a class.
 */
export function OrganizationPage() {
  const { t } = useLingui();
  const { available, reason } = useMembershipAvailability();
  // Orgs are role-walk scoped by the hub, so this is "the schools you can see" — and it supports
  // someone belonging to more than one, which the login payload's single ``organization`` claim
  // cannot express. Only IDs are read from this query: each `OrgUnit` fetches its own live name
  // (and everything else) from the budgets read, which is what stays fresh after a rename.
  // Memoized: ``useEntitiesQuery`` re-subscribes when the request identity changes and its
  // subscribe callback re-renders immediately, so a request built inline renders -> resubscribes
  // -> renders forever ("Maximum update depth exceeded").
  const orgQuery = useMemo(() => new QueryRequest({ type: Organization.type, query: {} }), []);
  const { data: orgs, isLoading, refetch } = useEntitiesQuery<Organization>(orgQuery);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const submitOrganization = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      await createOrganization(trimmed);
      setName('');
      setCreateOpen(false);
      notify.success({ title: t`Organization created`, message: t`${trimmed} is ready.`, id: 'org-create' });
      void refetch();
    } catch (err) {
      notify.error({
        title: t`Could not create organization`,
        message: err instanceof Error ? err.message : t`Unknown error.`,
        id: 'org-create',
      });
    } finally {
      setCreating(false);
    }
  };

  const organizations = useMemo(() => (Array.isArray(orgs) ? orgs : []), [orgs]);

  if (!available) {
    return (
      <Shell
        createOpen={createOpen}
        setCreateOpen={setCreateOpen}
        name={name}
        setName={setName}
        creating={creating}
        onCreate={() => void submitOrganization()}
      >
        <EmptyState
          icon={Users}
          title={reason === 'local' ? t`Not available in Local mode` : t`Sign in to manage people`}
          body={
            reason === 'local' ? (
              <Trans>Organizations and teams live in the cloud. Switch out of Local mode to manage them.</Trans>
            ) : (
              <Trans>Sign in to see the people and teams you share work with.</Trans>
            )
          }
        />
      </Shell>
    );
  }

  if (isLoading && organizations.length === 0) {
    return (
      <Shell
        createOpen={createOpen}
        setCreateOpen={setCreateOpen}
        name={name}
        setName={setName}
        creating={creating}
        onCreate={() => void submitOrganization()}
      >
        <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <Trans>Loading organizations…</Trans>
        </div>
      </Shell>
    );
  }

  if (organizations.length === 0) {
    return (
      <Shell
        createOpen={createOpen}
        setCreateOpen={setCreateOpen}
        name={name}
        setName={setName}
        creating={creating}
        onCreate={() => void submitOrganization()}
      >
        <EmptyState
          icon={Building2}
          title={t`No organization yet`}
          body={<Trans>You are not part of an organization. Once you join or create one, its teams appear here.</Trans>}
        />
      </Shell>
    );
  }

  return (
    <Shell
      createOpen={createOpen}
      setCreateOpen={setCreateOpen}
      name={name}
      setName={setName}
      creating={creating}
      onCreate={() => void submitOrganization()}
    >
      <div className="flex flex-col gap-4" data-testid="org-list">
        {organizations.map((org) => (
          <OrgUnit key={org.id} orgId={org.id} onDeleted={() => void refetch()} />
        ))}
      </div>
    </Shell>
  );
}

function Shell({
  children,
  createOpen,
  setCreateOpen,
  name,
  setName,
  creating,
  onCreate,
}: {
  children: React.ReactNode;
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  name: string;
  setName: (name: string) => void;
  creating: boolean;
  onCreate: () => void;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();

  return (
    <div className="flex h-full w-full flex-col px-6 py-6">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">
            <Trans>People &amp; teams</Trans>
          </h1>
          <p className="text-sm text-muted-foreground">
            <Trans>Organizations, the teams inside them, and who has a budget in each.</Trans>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!createOpen ? (
            <Button size="sm" data-testid="org-create-open" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              <Trans>New organization</Trans>
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCreate();
                  if (e.key === 'Escape') setCreateOpen(false);
                }}
                placeholder={t`Organization name…`}
                data-testid="org-create-name"
                className="w-44 rounded-md border border-border bg-background px-2.5 py-1 text-sm"
              />
              <Button size="sm" disabled={creating || !name.trim()} onClick={onCreate} data-testid="org-create-submit">
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                <Trans>Create</Trans>
              </Button>
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            data-testid="org-open-graph"
            onClick={() => navigation.openPage(PageId.HUB, ViewType.WORLDVIEW, WorldViewProjection.ORGANIZATION)}
          >
            <GitGraph className="h-4 w-4" />
            <Trans>Graph view</Trans>
          </Button>
        </div>
      </header>
      {children}
    </div>
  );
}

function EmptyState({ icon: Icon, title, body }: { icon: typeof Users; title: string; body: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
      <Icon className="h-8 w-8 text-muted-foreground" />
      <div className="text-sm font-medium">{title}</div>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
