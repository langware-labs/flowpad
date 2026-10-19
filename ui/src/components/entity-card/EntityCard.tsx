import { useEffect, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Agent, AgenticProcess, LLMEndpoint, Project, TypeId, type FSOriginField } from '@sdk';
import { GitBranch } from 'lucide-react';
import { AgentCardBody, CardLink } from '@src/components/agents/AgentIntroCard';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { useEntityLocationLabel } from '@src/components/graph-view/ui/EntityIcon';
import { useMyEndpoint } from '@src/components/llm-endpoints/my-endpoints';
import { TabTooltipName } from '@src/components/tabs/TabTooltipName';
import { CopyPathButton } from '@src/components/top-nav-bar/CopyPathButton';
import { useEntity } from '@src/hooks/entity-hooks';
import { assetGitLinkFor } from '@src/hooks/use-asset-git-link';
import { getGitStatus, type GitStatus } from '@src/lib/git-status-cache';
import { openExternal } from '@src/lib/open-external';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { ProcessTabCard } from '@src/tabs/provider-meta';
import { entityCardPath, entityCardRows, text, type EntityFields } from './entity-card-rows';

/**
 * What one entity IS, in a card: its name, kind and where it lives, its
 * description, the few facts worth a glance for its type (`entity-card-rows`),
 * its path and its git page. One body for every tab and crumb that names an
 * entity, so a new type gets a card by adding rows, not a component.
 */
export function EntityCardBody({
  type,
  entity,
  statusReason,
}: {
  type: string;
  entity: EntityFields;
  statusReason?: string;
}) {
  const remote = typeof entity.remote === 'boolean' ? entity.remote : undefined;
  const locationLabel = useEntityLocationLabel(remote);
  // Its own title when it has one; else its name, never a fabricated `type-uuid`.
  const title =
    text(entity.title) || (!entity.hasSyntheticDisplayName && text(entity.displayName)) || labelForType(type);
  const blurb = text(entity.description) || text(entity.summary);
  const rows = entityCardRows(type, entity);
  const path = entityCardPath(entity);
  const git = assetGitLinkFor((entity.git_origin ?? entity.origin) as FSOriginField | null | undefined, true);

  return (
    <div className="min-w-[220px] max-w-[320px] space-y-1.5 p-2.5" data-testid="entity-card">
      <TabTooltipName name={title} />
      {statusReason && <p className="text-[11px] text-amber-500">{statusReason}</p>}
      <p className="text-[11px] text-muted-foreground" data-testid="entity-card-kind">
        {[labelForType(type), locationLabel].filter(Boolean).join(' · ')}
      </p>
      {blurb && <p className="line-clamp-2 text-xs text-foreground/90">{blurb}</p>}
      {rows.length > 0 && (
        <div className="space-y-0.5">
          {rows.map((row, i) => (
            <div key={i} className="flex items-baseline gap-2 text-[11px]">
              <span className="w-20 shrink-0 truncate text-muted-foreground">{row.label}</span>
              {row.copy ? (
                <CopyPathButton path={row.value} testId="entity-card-copy" className="min-w-0 flex-1 py-0" />
              ) : (
                <span className="min-w-0 truncate text-foreground" title={row.value}>
                  {row.value}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {path && <CopyPathButton path={path} testId="entity-card-path" className="w-full" />}
      {/* A project's checkout is on this machine only when the project is. */}
      {type === Project.type && path && !remote && <ProjectGitLine workdir={path} />}
      {git.url && (
        <CardLink
          icon={GitBranch}
          label={git.repoLabel ?? git.url}
          title={git.url}
          onClick={() => openExternal(git.url!)}
          testId="entity-card-git"
        />
      )}
    </div>
  );
}

/**
 * A project's repository at a glance — branch, how much is uncommitted or
 * unpushed, and its page on the git host. One status read when the card opens,
 * through the shared git-status cache. Nothing for a folder that is not a checkout.
 */
function ProjectGitLine({ workdir }: { workdir: string }) {
  const { t } = useLingui();
  const [status, setStatus] = useState<GitStatus | null>(null);
  useEffect(() => {
    let live = true;
    void getGitStatus(LOCAL_COMPUTE_NODE.id, workdir).then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, [workdir]);
  if (!status?.branch || status.error) return null;
  const pending = [
    status.files.length ? t`${status.files.length} changed` : '',
    status.ahead ? t`${status.ahead} to push` : '',
    status.behind ? t`${status.behind} to pull` : '',
  ].filter(Boolean);
  const webUrl = status.remoteWebUrl;
  return (
    <CardLink
      icon={GitBranch}
      label={status.branch}
      suffix={pending.join(', ') || undefined}
      title={webUrl ?? undefined}
      onClick={webUrl ? () => openExternal(webUrl) : undefined}
      testId="entity-card-project-git"
    />
  );
}

interface EntityCardProps {
  /** The entity's type and id — strings, so a chip can carry a card without building a TypeId. */
  type: string;
  id: string;
  fallbackName: string;
  statusReason?: string;
}

/**
 * The card for an entity known only by its type and id — a tab chip, a
 * breadcrumb. Mounted inside a tooltip / hover card, so the fetch fires when it
 * opens. A session and an agent keep the cards they already have.
 */
export function EntityCard(props: EntityCardProps) {
  if (props.type === AgenticProcess.type) {
    return <ProcessTabCard processId={props.id} fallbackName={props.fallbackName} statusReason={props.statusReason} />;
  }
  // An LLM endpoint is a hub projection with no local row — it comes from the user's own endpoint list.
  return props.type === LLMEndpoint.type ? <LlmEndpointCard {...props} /> : <LoadedEntityCard {...props} />;
}

function LoadedEntityCard(props: EntityCardProps) {
  const typeId = useMemo(() => new TypeId(props.type, props.id), [props.type, props.id]);
  const entity = useEntity(typeId).data;
  if (entity && props.type === Agent.type) {
    return (
      <div className="w-72" data-testid="entity-card-agent">
        <AgentCardBody agent={entity as Agent} />
      </div>
    );
  }
  return <EntityView {...props} entity={entity as EntityFields | null | undefined} />;
}

function LlmEndpointCard(props: EntityCardProps) {
  const { endpoint } = useMyEndpoint(props.id);
  return <EntityView {...props} entity={endpoint ? { ...endpoint, displayName: endpoint.name } : null} />;
}

/** The card once its entity is in hand — the bare name while it is not. */
function EntityView({ type, fallbackName, statusReason, entity }: EntityCardProps & { entity?: EntityFields | null }) {
  if (entity) return <EntityCardBody type={type} entity={entity} statusReason={statusReason} />;
  return (
    <div className="space-y-1 px-3 py-1.5">
      <TabTooltipName name={fallbackName} className="font-normal" />
      <p className="text-[11px] text-muted-foreground">{labelForType(type)}</p>
      {statusReason && <p className="text-[11px] text-amber-500">{statusReason}</p>}
    </div>
  );
}

/** A web page opened as a tab — no entity behind it, just where it points. */
export function UrlTabCard({ name, url }: { name: string; url: string }) {
  return (
    <div className="min-w-[220px] max-w-[320px] space-y-1.5 p-2.5" data-testid="url-tab-card">
      <TabTooltipName name={name} />
      <CopyPathButton path={url} testId="url-tab-card-url" className="w-full" />
    </div>
  );
}
