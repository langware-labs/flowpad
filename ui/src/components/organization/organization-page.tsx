import { PageId, QueryRequest, ViewType, WorldViewProjection } from '@sdk';
import { Building2, ChevronDown, ChevronRight, GitGraph, Loader2, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { Button } from '@src/components/ui/button';
import { useEntitiesQuery } from '@src/hooks/entity-hooks/useEntitiesQuery';
import { useMembershipAvailability } from '@src/hooks/use-membership-availability';
import { OrgDetailPanel } from '@src/components/organization/org-detail-panel';
import { useGroupChildren } from '@src/components/organization/use-group-children';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/**
 * People and teams — the plain screen.
 *
 * Master–detail, the standard shape for hierarchical administration (and what
 * GitHub, Google Workspace and Okta all settle on): the structure lives in a tree
 * on the left, and the selected node's roster fills the right. Nothing here needs
 * to be learned — you read the tree top to bottom and edit the table beside it.
 *
 * The Organization WorldView shows the SAME data as a force-directed graph. That
 * is the advanced view: excellent for seeing shape and reach at a glance, wrong as
 * the place you go to add a class. This page links to it rather than being it.
 */
export function OrganizationPage() {
  const { t } = useLingui();
  const { available, reason } = useMembershipAvailability();
  // Orgs are role-walk scoped by the hub, so this is "the schools you can see" —
  // and it supports someone belonging to more than one, which the login payload's
  // single ``organization`` claim cannot express.
  // Memoized: ``useEntitiesQuery`` re-subscribes when the request identity changes
  // and its subscribe callback re-renders immediately, so a request built inline
  // renders -> resubscribes -> renders forever ("Maximum update depth exceeded").
  const orgQuery = useMemo(() => new QueryRequest({ type: 'organization', query: {} }), []);
  const { data: orgs, isLoading } = useEntitiesQuery(orgQuery);
  const [selected, setSelected] = useState<{ type: string; id: string; label: string } | null>(null);

  const organizations = useMemo(() => (Array.isArray(orgs) ? orgs : []), [orgs]);
  const current = selected ?? firstOrgNode(organizations);

  if (!available) {
    return (
      <Shell>
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
      <Shell>
        <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <Trans>Loading organizations…</Trans>
        </div>
      </Shell>
    );
  }

  if (organizations.length === 0) {
    return (
      <Shell>
        <EmptyState
          icon={Building2}
          title={t`No organization yet`}
          body={<Trans>You are not part of an organization. Once you join or create one, its teams appear here.</Trans>}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex min-h-0 flex-1 gap-6">
        <nav className="w-64 shrink-0 overflow-y-auto border-r border-border pr-3" aria-label={t`Organization`}>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Trans>Structure</Trans>
          </div>
          <ul role="tree" className="flex flex-col gap-0.5">
            {organizations.map((org: { id: string; name?: string }) => (
              <TreeNode
                key={org.id}
                node={{ type: 'organization', id: org.id, label: org.name || t`Organization` }}
                depth={0}
                selectedId={current?.id ?? null}
                onSelect={setSelected}
              />
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {current && (
            <OrgDetailPanel
              nodeType={current.type}
              nodeId={current.id}
              nodeLabel={current.label}
              onOpenChild={setSelected}
            />
          )}
        </div>
      </div>
    </Shell>
  );
}

/**
 * One row of the structure tree, lazily loading its children when opened.
 *
 * Progressive disclosure on purpose: a school with forty classes should not fetch
 * forty rosters to draw a sidebar, and depth is unbounded in the data model.
 */
function TreeNode({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  node: { type: string; id: string; label: string };
  depth: number;
  selectedId: string | null;
  onSelect: (node: { type: string; id: string; label: string }) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const { children, loading } = useGroupChildren(node.type, node.id, open);
  const isSelected = selectedId === node.id;
  const Icon = node.type === 'organization' ? Building2 : Users;

  return (
    <li role="treeitem" aria-expanded={open} aria-selected={isSelected}>
      <div
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-sm ${
          isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
        }`}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        <button
          type="button"
          aria-label={open ? 'Collapse' : 'Expand'}
          data-testid="org-tree-toggle"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button
          type="button"
          data-testid="org-tree-node"
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left"
          onClick={() => onSelect(node)}
        >
          <Icon size={14} className="shrink-0 text-muted-foreground" />
          <span className="truncate">{node.label}</span>
        </button>
        {loading && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
      </div>
      {open && children.length > 0 && (
        <ul role="group" className="flex flex-col gap-0.5">
          {children.map((child) => (
            <TreeNode key={child.id} node={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { navigation } = useDockNavigation();

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col px-6 py-6">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">
            <Trans>People &amp; teams</Trans>
          </h1>
          <p className="text-sm text-muted-foreground">
            <Trans>Organizations, the teams inside them, and who belongs to each.</Trans>
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          data-testid="org-open-graph"
          onClick={() => navigation.openPage(PageId.HUB, ViewType.WORLDVIEW, WorldViewProjection.ORGANIZATION)}
        >
          <GitGraph className="h-4 w-4" />
          <Trans>Graph view</Trans>
        </Button>
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

function firstOrgNode(orgs: Array<{ id: string; name?: string }>) {
  const first = orgs[0];
  return first ? { type: 'organization', id: first.id, label: first.name || 'Organization' } : null;
}
