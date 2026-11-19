import { TypeId, type Deployment } from '@sdk';
import type { I18n } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Plus, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { IssueBanners } from '@src/components/asset-counters/issue-counters';
import { canInviteMembers } from '@src/components/conversation/participant-display';
import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { formatRelative } from '@src/components/git/relative-time';
import { deploymentRowState, ITEM_STATES } from '@src/components/items/item-state';
import { InviteRow } from '@src/components/organization/invite-row';
import { MemberSection, type MemberActions } from '@src/components/organization/member-list';
import { BreadcrumbChevron } from '@src/components/ui/breadcrumb';
import { Button } from '@src/components/ui/button';
import { useMembers } from '@src/hooks/use-members';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { TileCount, TileFace, WhereIcon, type HomeTilesState } from './HomeTiles';
import { pageOf, type HomeTile } from './home-tiles-model';

const ICON_BUTTON = 'rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground';

/** Who can reach the selected thing; `+` opens the invite (address, role, Send). */
function AccessSection({ typeid, own }: { typeid: string; own: boolean }) {
  const { t } = useLingui();
  // One TypeId per target: the roster hook refetches when it is handed a new one.
  const typeId = useMemo(() => new TypeId(typeid), [typeid]);
  const { localUser } = useLocalUser();
  const { members, ready, updating, stale, available, reason, refresh, removeMember, setRole } = useMembers(typeId);
  const [inviting, setInviting] = useState(false);
  const selfId = localUser?.id ?? '';
  // Something of yours that was never shared has no roster yet: you are its owner all the same.
  const me = useMemo(
    () => members.find((m) => !!m.user_id && m.user_id === selfId) ?? (own && selfId ? { user_id: selfId, roles: ['owner'] } : null),
    [members, selfId, own],
  );
  const actions: MemberActions = useMemo(() => {
    const guard = (title: string, run: () => Promise<void>) =>
      run().catch((err: unknown) => {
        notify.error({ title, message: err instanceof Error ? err.message : t`Unknown error.`, id: 'home-access' });
      });
    return {
      onSetRole: (principalId, roles) => guard(t`Could not change role`, () => setRole(principalId, roles)),
      onRemove: (principalId) => guard(t`Could not remove`, () => removeMember(principalId)),
    };
  }, [removeMember, setRole, t]);
  const canInvite = available && ready && !stale && canInviteMembers(me as never);

  return (
    <section className="flex flex-col gap-2" data-testid="home-access">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="flex-1">
          <Trans>Access</Trans>
        </span>
        {canInvite && (
          <button
            type="button"
            className={cn(ICON_BUTTON, 'border border-border', inviting && 'border-primary text-foreground')}
            aria-label={t`Invite`}
            title={t`Invite`}
            aria-expanded={inviting}
            onClick={() => setInviting((on) => !on)}
            data-testid="home-access-invite-toggle"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
      {available ? (
        <MemberSection
          members={members}
          ready={ready}
          updating={updating}
          stale={stale}
          selfId={selfId}
          me={me}
          manage
          actions={actions}
          footer={
            inviting && <InviteRow entityTypeId={typeId} me={me} testIdPrefix="home-access" onInvited={() => void refresh()} />
          }
        />
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="home-access-unavailable">
          {reason === 'local' ? (
            <Trans>Members are unavailable in Local mode.</Trans>
          ) : (
            <Trans>Sign in to see who has access.</Trans>
          )}
        </p>
      )}
    </section>
  );
}

function WhereLabel({ local }: { local: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <WhereIcon local={local} className="h-3.5 w-3.5" />
      {local ? <Trans>This machine</Trans> : <Trans>Cloud</Trans>}
    </span>
  );
}

function Property({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-t border-border py-1.5 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-foreground">{children}</span>
    </div>
  );
}

/** The deployments behind one icon. Nothing is marked in the list: a row opens that deployment as a sub view. */
function DeploymentList({
  deployments,
  issues,
  onPick,
}: {
  deployments: Deployment[];
  /** Open issues per deployment id. */
  issues: Map<string, number>;
  onPick: (deployment: Deployment) => void;
}) {
  const { t, i18n } = useLingui();
  const [page, setPage] = useState(0);
  const { rows, first, pages } = pageOf(deployments, page);
  return (
    <section className="flex flex-col gap-1.5" data-testid="home-deployments">
      <div className="text-xs text-muted-foreground">
        <Trans>Deployments · {deployments.length}</Trans>
      </div>
      {rows.map((deployment) => {
        const open = issues.get(deployment.id) ?? 0;
        return (
          <button
            key={deployment.id}
            type="button"
            onClick={() => onPick(deployment)}
            className="flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-2 text-xs text-foreground hover:bg-accent"
            data-testid="home-deployment-row"
            data-deployment-id={deployment.id}
          >
            <WhereIcon local={deployment.isLocal} className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-start">{deployment.name}</span>
            {open > 0 && <TileCount value={open} tone="issues" />}
            <span className="shrink-0 text-muted-foreground">{statusOf(deployment, i18n)}</span>
            <BreadcrumbChevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        );
      })}
      {pages > 1 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="home-deployments-pager">
          <span className="flex-1 tabular-nums">
            <Trans>
              {first}–{first + rows.length - 1} of {deployments.length}
            </Trans>
          </span>
          <button
            type="button"
            className={cn(ICON_BUTTON, 'border border-border disabled:opacity-40')}
            aria-label={t`Previous page`}
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            <BreadcrumbChevron className="h-3.5 w-3.5 rotate-180" />
          </button>
          <button
            type="button"
            className={cn(ICON_BUTTON, 'border border-border disabled:opacity-40')}
            aria-label={t`Next page`}
            disabled={page >= pages - 1}
            onClick={() => setPage(page + 1)}
            data-testid="home-deployments-next"
          >
            <BreadcrumbChevron className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </section>
  );
}

function statusOf(deployment: Deployment, i18n: I18n): string {
  return i18n._(ITEM_STATES[deploymentRowState(deployment)].label);
}

function updated(entity: { updated_date?: Date | string | null } | null | undefined): string {
  const at = entity?.updated_date;
  return at ? formatRelative(new Date(at).toISOString()) : '';
}

function kindLine(tile: HomeTile, deployment: Deployment | null, hasTarget: boolean): ReactNode {
  if (deployment) return <Trans>Deployment</Trans>;
  if (!hasTarget) return <Trans>Pick a deployment</Trans>;
  return tile.kind === 'agent' ? <Trans>Agent · yours</Trans> : <Trans>App · yours</Trans>;
}

/**
 * The home's side panel: the selected agent, app or deployment — who has access, its properties, Open and
 * Manage. An icon that stands only for several deployments shows just their list until one is picked.
 */
export function HomePropertiesPanel({ home }: { home: HomeTilesState }) {
  const { t, i18n } = useLingui();
  const { selection, select, open, manage } = home;
  if (!selection) return null;
  const { tile, deployment, listed, subView } = selection;
  const target = deployment ?? (tile.own ? (tile.agent ?? tile.app?.app) : null);
  const targetKey = target?.typeId.toString();
  const description = tile.agent?.description ?? tile.app?.app.description;
  const when = updated(target);

  return (
    <aside
      // Keyed so a deployment opened from the list slides in as its own view, and the invite closes with it.
      key={targetKey ?? tile.key}
      className={cn(
        'absolute inset-y-0 end-0 z-20 flex w-80 max-w-full flex-col gap-4 overflow-y-auto border-s border-border bg-card p-4 text-start shadow-xl',
        subView && 'duration-300 animate-in fade-in slide-in-from-right-8',
      )}
      data-testid="home-properties"
      data-target={targetKey ?? ''}
    >
      {subView && (
        <nav aria-label={t`Breadcrumb`} className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="home-properties-crumbs">
          <button
            type="button"
            onClick={() => select(tile.key)}
            className="-ms-1.5 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            data-testid="home-properties-crumb-root"
          >
            {tile.label}
          </button>
          <BreadcrumbChevron className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-medium text-foreground">{deployment?.name}</span>
        </nav>
      )}
      <header className="flex items-center gap-3">
        <TileFace tile={tile} className="h-11 w-11 text-base" glyphClassName="h-6 w-6 text-2xl" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground" data-testid="home-properties-title">
            {deployment?.name ?? tile.label}
          </div>
          <div className="text-xs text-muted-foreground">{kindLine(tile, deployment, !!target)}</div>
        </div>
        <button type="button" className={ICON_BUTTON} aria-label={t`Close`} onClick={() => select(null)} data-testid="home-properties-close">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>

      {target && description && <p className="text-sm text-muted-foreground">{description}</p>}
      {listed.length > 0 && (
        <DeploymentList deployments={listed} issues={tile.deploymentIssues} onPick={(d) => select(tile.key, d.id)} />
      )}

      {targetKey && (
        <>
          <IssueBanners typeid={targetKey} className="overflow-hidden rounded-md border border-border" />
          <AccessSection typeid={targetKey} own={tile.own} />
          <div>
            {(deployment || tile.kind === 'agent') && (
              <Property label={<Trans>Runs on</Trans>}>
                <WhereLabel local={deployment ? deployment.isLocal : true} />
              </Property>
            )}
            {deployment && (
              <Property label={<Trans>Status</Trans>}>{statusOf(deployment, i18n)}</Property>
            )}
            {when && <Property label={<Trans>Updated</Trans>}>{when}</Property>}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => open(tile, deployment)} data-testid="home-properties-open">
              <Trans>Open</Trans>
            </Button>
            {tile.own && !deployment && (
              <Button size="sm" variant="outline" onClick={() => manage(tile)} data-testid="home-properties-manage">
                <Trans>Manage</Trans>
              </Button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
