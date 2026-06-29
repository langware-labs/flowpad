import { APIEntity, TypeId } from '@sdk';
import { useMemo } from 'react';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';

interface OrganizationChipProps {
  orgId: string;
  /** The user's role on the organization (e.g. "member" / "admin"). */
  role?: string;
}

/**
 * Pill showing the user's organization: the registry-driven type icon, the org
 * name, and (optionally) the user's role. The glyph comes from
 * ``iconForType('organization')`` — never hardcoded (type-icon rule). The org
 * name is read from the locally-materialized remote Organization entity.
 */
export function OrganizationChip({ orgId, role }: OrganizationChipProps) {
  const typeId = useMemo(() => new TypeId('organization', orgId), [orgId]);
  const { data: org } = useEntity<APIEntity<any>>(typeId);
  const Icon = iconForType('organization');
  const name = (org as any)?.name || 'Organization';

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-medium">
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{name}</span>
      {role && <span className="text-muted-foreground">· {role}</span>}
    </span>
  );
}
