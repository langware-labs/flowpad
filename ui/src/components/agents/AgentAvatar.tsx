import type React from 'react';
import type { Agent } from '@sdk';
import { useLingui } from '@lingui/react/macro';

import { cn } from '@src/lib/utils';
import { AvatarValue } from '@src/lib/avatar-value';
import { colorForIdentityKey } from '@src/components/conversation/avatar-color';
import { initialsFromLabel } from '@src/components/conversation/participant-display';

interface AgentAvatarProps {
  agent: Agent;
  /** Tailwind size classes for the circle, e.g. `h-6 w-6 text-[11px]`. */
  className?: string;
  /** Size classes for a glyph/emoji avatar (an image always fills the circle). */
  glyphClassName?: string;
  /**
   * Caller-resolved image URL. Defaults to `agent.avatarImageUrl`; the profile
   * editor passes the URL off its router-provided ref (authoritative for hub
   * entity storage), everyone else lets the entity resolve it.
   */
  imageUrl?: string | null;
  /** Rendered when the agent has neither image nor glyph. Default: the name's initial. */
  fallback?: React.ReactNode;
  'data-testid'?: string;
}

/**
 * The one way an Agent's face is drawn: a circle in the agent's identity
 * color holding its uploaded image, its emoji/icon, or — when it has none —
 * the initial of its display name. Used wherever an agent is named as an
 * actor: the pinned row of a process's asset list, the chat identity row.
 */
export function AgentAvatar({
  agent,
  className,
  glyphClassName = 'h-3.5 w-3.5 text-sm',
  imageUrl = agent.avatarImageUrl,
  fallback,
  ...rest
}: AgentAvatarProps) {
  const { t } = useLingui();
  const name = agent.displayName;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white',
        colorForIdentityKey(agent.name || agent.id),
        className,
      )}
      data-testid={rest['data-testid']}
    >
      <AvatarValue
        value={agent.avatar}
        imageUrl={imageUrl}
        alt={t`${name} avatar`}
        className={imageUrl ? 'h-full w-full object-cover' : glyphClassName}
        fallback={fallback ?? <span>{initialsFromLabel(name, 1)}</span>}
      />
    </span>
  );
}
