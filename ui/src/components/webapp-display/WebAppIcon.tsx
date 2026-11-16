import { createElement } from 'react';
import type { WebApp } from '@sdk';
import { AvatarValue } from '@src/lib/avatar-value';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { colorForIdentityKey } from '@src/components/conversation/avatar-color';
import { initialsFromLabel } from '@src/components/conversation/participant-display';
import { cn } from '@src/lib/utils';

/** An app's face: its own icon (`webapp.json` `icon`, a lucide name or an emoji), else its type's icon. */
export function WebAppIcon({ app, className = 'size-4 shrink-0' }: { app: WebApp; className?: string }) {
  const fallback = createElement(iconForType(app.type), { className, 'aria-hidden': true });
  return <AvatarValue value={app.icon} alt={app.displayName ?? app.name} className={className} fallback={fallback} />;
}

/** An app drawn like an agent's avatar: a circle in its name-derived color holding its icon, else its initial. */
export function WebAppAvatar({
  app,
  className,
  glyphClassName = 'h-3.5 w-3.5 text-sm',
}: {
  app: WebApp;
  className?: string;
  glyphClassName?: string;
}) {
  const name = app.displayName ?? app.name;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white',
        colorForIdentityKey(app.name || app.id),
        className,
      )}
    >
      <AvatarValue
        value={app.icon}
        alt={name}
        className={glyphClassName}
        fallback={<span>{initialsFromLabel(name, 1)}</span>}
      />
    </span>
  );
}
