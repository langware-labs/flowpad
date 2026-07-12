import type { APIEntity } from '@sdk';
import { iconForType } from '../icons/iconRegistry';
import { IconWithBadge } from '../icons/IconWithBadge';
import { subIconForEntity } from '../icons/subIconRegistry';

type Props = {
  type: string;
  size?: number;
  color?: string;
  strokeWidth?: number;
};

export function EntityIcon({ type, size = 16, color, strokeWidth = 2 }: Props) {
  const Icon = iconForType(type);
  return <Icon size={size} color={color} strokeWidth={strokeWidth} />;
}

/**
 * Entity icon with its per-instance sub-icon badge (when the type has a selector
 * — see {@link subIconForEntity}). Requires the entity INSTANCE (not just a type
 * string). Degrades to a plain base icon when there's no sub-icon.
 */
export function EntityIconWithSub({ entity, className }: { entity: APIEntity<any>; className?: string }) {
  return (
    <IconWithBadge Base={iconForType(entity.getType())} Badge={subIconForEntity(entity)} className={className} />
  );
}
