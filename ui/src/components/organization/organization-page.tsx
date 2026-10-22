import { Organization, PageId, QueryRequest, ViewType, WorldViewProjection } from '@sdk';
import { Building2, GitGraph, Loader2, Plus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { Button } from '@src/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { useEntitiesQuery } from '@src/hooks/entity-hooks/useEntitiesQuery';
import { useMembershipAvailability } from '@src/hooks/use-membership-availability';
import { createOrganization } from '@src/components/organization/create-organization';
import { OrgView } from '@src/components/organization/tabs/OrgView';
import { useOrgRoute } from '@src/components/organization/tabs/org-route';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

/**
 * People and teams.
 *
 * One organization at a time, picked top-left (shown only when the caller is in more than one),
 * split into tabs: Teams | Members | Billing & keys | General. A team opens on its own page. The
 * org, tab and team ride in the URL (`useOrgRoute`), so reload and Back land where you were.
 *
 * The Organization WorldView shows the SAME data as a graph — "Graph view" in the header.
 */
export function OrganizationPage() {
  const { t } = useLingui();
  const { available, reason } = useMembershipAvailability();
  const route = useOrgRoute();
  // Orgs are role-walk scoped by the hub, so this is "the orgs you can see". Memoized:
  // ``useEntitiesQuery`` re-subscribes when the request identity changes.
  const orgQuery = useMemo(() => new QueryRequest({ type: Organization.type, query: {} }), []);
  const { data: orgs, isLoading, refetch } = useEntitiesQuery<Organization>(orgQuery);
  const organizations = useMemo(() => (Array.isArray(orgs) ? orgs : []), [orgs]);
  const selected = organizations.find((o) => o.id === route.orgId) ?? organizations[0];

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const submitOrganization = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const created = await createOrganization(trimmed);
      setName('');
      setCreateOpen(false);
      notify.success({ title: t`Organization created`, message: t`${trimmed} is ready.`, id: 'org-create' });
      await refetch();
      if (created?.id) route.setOrg(created.id);
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

  const create = { createOpen, setCreateOpen, name, setName, creating, onCreate: () => void submitOrganization() };

  if (!available) {
    return (
      <Shell {...create}>
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
      <Shell {...create}>
        <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <Trans>Loading organizations…</Trans>
        </div>
      </Shell>
    );
  }

  if (!selected) {
    return (
      <Shell {...create}>
        <EmptyState
          icon={Building2}
          title={t`No organization yet`}
          body={<Trans>You are not part of an organization. Once you join or create one, its teams appear here.</Trans>}
        />
      </Shell>
    );
  }

  const picker =
    organizations.length > 1 ? (
      <div className="flex items-center gap-2">
        <OrgInitial name={selected.name} />
        <Select value={selected.id} onValueChange={route.setOrg}>
          <SelectTrigger className="h-9 w-72" data-testid="org-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {organizations.map((org) => (
              <SelectItem key={org.id} value={org.id} data-testid={`org-select-${org.id}`}>
                {org.name || org.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ) : (
      <div className="flex items-center gap-2 text-base font-semibold" data-testid="org-name">
        <OrgInitial name={selected.name} />
        {selected.name}
      </div>
    );

  return (
    <Shell {...create} picker={picker}>
      <OrgView
        key={selected.id}
        orgId={selected.id}
        name={selected.name}
        tab={route.tab}
        teamId={route.teamId}
        onTab={route.setTab}
        onOpenTeam={route.openTeam}
        onCloseTeam={route.closeTeam}
        onDeleted={() => {
          void refetch();
          const next = organizations.find((o) => o.id !== selected.id);
          if (next) route.setOrg(next.id);
        }}
      />
    </Shell>
  );
}

function OrgInitial({ name }: { name?: string }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary/20 text-[11px] font-bold text-primary">
      {(name || '?').charAt(0).toUpperCase()}
    </span>
  );
}

function Shell({
  children,
  picker,
  createOpen,
  setCreateOpen,
  name,
  setName,
  creating,
  onCreate,
}: {
  children: React.ReactNode;
  picker?: React.ReactNode;
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
    <div className="flex h-full w-full flex-col overflow-y-auto px-6 py-6">
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {picker ?? (
              <h1 className="text-lg font-semibold">
                <Trans>People &amp; teams</Trans>
              </h1>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!createOpen ? (
              <Button size="sm" variant="outline" data-testid="org-create-open" onClick={() => setCreateOpen(true)}>
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
                <Button
                  size="sm"
                  disabled={creating || !name.trim()}
                  onClick={onCreate}
                  data-testid="org-create-submit"
                >
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
