import { useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Agent, isGitOrigin } from '@sdk';
import { ExternalLink, Folder, GitBranch, MessageSquare, type LucideIcon } from 'lucide-react';

import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { workerLabel } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { MediaLightbox } from '@src/components/ui/media-lightbox';
import { cn } from '@src/lib/utils';
import { openExternal } from '@src/lib/open-external';
import { assetGitLinkFor } from '@src/hooks/use-asset-git-link';
import { useEntityLocationLabel } from '@src/components/graph-view/ui/EntityIcon';
import { AgentAvatar } from './AgentAvatar';

interface AgentIntroCardProps {
  agent: Agent;
  /** The element that opens the card — an avatar, a name, an identity row. */
  children: ReactNode;
  /**
   * How the card opens. `click` (default) is the identity-row behaviour: the
   * trigger's whole job is to explain who this is. `hover` is for a trigger
   * that already HAS a primary action — an agent tile, whose click must start
   * the session — where a click-trigger would swallow it.
   */
  trigger?: 'click' | 'hover';
  /** Replace the default editor action with an explicit "Use agent" action. */
  onUse?: () => void;
  /** A disabled Agent can still be inspected, but cannot start a session. */
  useDisabled?: boolean;
}

/**
 * The agent card itself — avatar, title, slug, the authored one-line
 * description, the runtime it runs on, where it lives (folder and git), and one
 * contextual action: open it by default, or use it when shown over a launch
 * tile. ONE body for every surface that explains an agent (the intro popover,
 * the hover card, a session tab's tooltip), so they cannot drift apart.
 */
export function AgentCardBody({
  agent,
  onUse,
  useDisabled = false,
  onAvatarClick,
}: Pick<AgentIntroCardProps, 'agent' | 'onUse' | 'useDisabled'> & {
  /** Open the uploaded avatar full size. Omitted where there is nowhere to host
   *  the lightbox (a tooltip closes under it) — the avatar is then plain. */
  onAvatarClick?: () => void;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const title = agent.displayName;
  const slug = agent.name && agent.name !== title ? agent.name : null;
  const runtime = [
    agent.worker_type ? workerLabel(agent.worker_type) : null,
    agent.model,
    agent.permission_mode,
  ].filter((chip): chip is string => !!chip);
  const ActionIcon = onUse ? MessageSquare : ExternalLink;
  const avatar = <AgentAvatar agent={agent} className="h-12 w-12 text-lg" glyphClassName="h-6 w-6 text-2xl" />;
  const openAgent = () => navigation.openDock(agent.dockPointer);
  const directory = agent.bundleDirectory;
  const locationLabel = useEntityLocationLabel(agent.remote);
  const git = assetGitLinkFor(agent.git_origin, true);
  const branch = isGitOrigin(agent.git_origin) ? agent.git_origin.branch : '';

  return (
    <>
      <div className="flex items-start gap-3 p-3">
        {onAvatarClick && agent.avatarImageUrl ? (
          <button
            type="button"
            className="shrink-0 cursor-zoom-in rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onAvatarClick}
            aria-label={t`View ${title} avatar`}
            data-testid="agent-intro-card-avatar"
          >
            {avatar}
          </button>
        ) : (
          avatar
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground" data-testid="agent-intro-card-title">
            {title}
          </div>
          {slug && <div className="truncate font-mono text-[11px] text-muted-foreground">{slug}</div>}
          <AgentTypeChip className="mt-1" />
        </div>
      </div>
      {agent.description ? (
        <p className="px-3 pb-3 text-xs leading-relaxed text-foreground/90" data-testid="agent-intro-card-description">
          {agent.description}
        </p>
      ) : (
        <p className="px-3 pb-3 text-xs italic text-muted-foreground">
          <Trans>No description yet.</Trans>
        </p>
      )}
      {runtime.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-3">
          {runtime.map((chip) => (
            <Badge key={chip} variant="secondary" className="font-mono text-[10px] font-normal">
              {chip}
            </Badge>
          ))}
        </div>
      )}
      {(directory || git.url) && (
        <div className="space-y-1 px-3 pb-3">
          {directory && (
            <CardLink
              icon={Folder}
              label={directory}
              suffix={locationLabel}
              title={[directory, locationLabel].filter(Boolean).join(' — ')}
              onClick={openAgent}
              testId="agent-intro-card-location"
            />
          )}
          {git.url && (
            <CardLink
              icon={GitBranch}
              label={[git.repoLabel, branch].filter(Boolean).join(' · ')}
              title={git.url}
              onClick={() => openExternal(git.url!)}
              testId="agent-intro-card-git"
            />
          )}
        </div>
      )}
      <div className="border-t border-border p-2">
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-start"
          onClick={onUse ?? openAgent}
          disabled={onUse ? useDisabled : false}
          data-testid={onUse ? 'agent-intro-card-use' : 'agent-intro-card-open'}
          title={onUse ? t`Use agent` : t`Open ${title}`}
        >
          <ActionIcon className="me-1.5 h-3.5 w-3.5" />
          {onUse ? <Trans>Use agent</Trans> : <Trans>Open agent</Trans>}
        </Button>
      </div>
    </>
  );
}

/** One "where it lives" line of a card: a glyph, a path-like label, and a click when
 *  there is somewhere to go. */
export function CardLink({
  icon: Icon,
  label,
  suffix,
  title,
  onClick,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  suffix?: string;
  title?: string;
  onClick?: () => void;
  testId: string;
}) {
  const className = 'flex w-full items-center gap-1.5 text-start text-[11px] text-muted-foreground';
  const line = (
    <>
      <Icon className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate font-mono" dir="ltr">
        {label}
      </span>
      {suffix && <span className="shrink-0">· {suffix}</span>}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={`${className} hover:text-foreground`}
      onClick={onClick}
      title={title}
      data-testid={testId}
    >
      {line}
    </button>
  ) : (
    <div className={className} title={title} data-testid={testId}>
      {line}
    </div>
  );
}

/**
 * Who is this? — the agent's intro card, opened from anywhere the agent is
 * named as an actor (a chat turn, the pinned asset row).
 */
export function AgentIntroCard({
  agent,
  children,
  trigger = 'click',
  onUse,
  useDisabled = false,
}: AgentIntroCardProps) {
  const title = agent.displayName;
  // The lightbox state lives here, not in the card body: opening it clicks
  // outside the popover, which closes (unmounts) the body.
  const [avatarOpen, setAvatarOpen] = useState(false);
  const avatarImageUrl = agent.avatarImageUrl;

  // ONE card body, two ways of opening it — never a second description popover
  // that could drift from this one. Spelled out as two JSX trees rather than a
  // swapped component tuple so each primitive's own props stay type-checked.
  const body = (
    <AgentCardBody agent={agent} onUse={onUse} useDisabled={useDisabled} onAvatarClick={() => setAvatarOpen(true)} />
  );

  const lightbox = avatarOpen && avatarImageUrl && (
    <MediaLightbox url={avatarImageUrl} name={`${title} avatar.png`} onClose={() => setAvatarOpen(false)} />
  );

  const card =
    trigger === 'hover' ? (
      <HoverCard openDelay={200} closeDelay={100}>
        <HoverCardTrigger asChild>{children}</HoverCardTrigger>
        <HoverCardContent align="start" className="w-72 p-0" data-testid="agent-intro-card">
          {body}
        </HoverCardContent>
      </HoverCard>
    ) : (
      <Popover>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0" data-testid="agent-intro-card">
          {body}
        </PopoverContent>
      </Popover>
    );
  return (
    <>
      {card}
      {lightbox}
    </>
  );
}

/** The small uppercase type chip shown beside an agent's name. The word comes
 *  from the type registry (`TypeInfo.display_name`), the same choke point the
 *  section heading uses — a literal here would fork the type's own name. */
export function AgentTypeChip({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn('text-[10px] font-normal uppercase tracking-wider text-muted-foreground', className)}
    >
      {labelForType(Agent.type)}
    </Badge>
  );
}
