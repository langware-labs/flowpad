import { createElement } from 'react';
import type { WebApp } from '@sdk';
import { AvatarValue } from '@src/lib/avatar-value';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';

/** An app's face: its own icon (`webapp.json` `icon`, a lucide name or an emoji), else its type's icon. */
export function WebAppIcon({ app, className = 'size-4 shrink-0' }: { app: WebApp; className?: string }) {
  const fallback = createElement(iconForType(app.type), { className, 'aria-hidden': true });
  return <AvatarValue value={app.icon} alt={app.displayName ?? app.name} className={className} fallback={fallback} />;
}
