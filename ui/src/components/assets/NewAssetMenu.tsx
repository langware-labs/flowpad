import { Plus } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { getDescriptor, type QuickCreateGroup } from '@src/components/quick-create/registry';
import type { AssetTypeInfo } from '@src/hooks/use-asset-types';

const GROUPS: { group: QuickCreateGroup; label: ReactNode }[] = [
  { group: 'build', label: <Trans>Build AI</Trans> },
  { group: 'write', label: <Trans>Write & plan</Trans> },
  { group: 'connect', label: <Trans>Connect</Trans> },
];

/** The assets sidebar's header "+": every creatable type, including ones the
 *  scope has none of yet (those have no tree row, so no per-row "+"). */
export function NewAssetMenu({ types, onNew }: { types: readonly AssetTypeInfo[]; onNew: (type: string) => void }) {
  const { t } = useLingui();
  const sections = GROUPS.map(({ group, label }) => ({
    group,
    label,
    items: types.filter((ty) => ty.creatable && getDescriptor(ty.type_name)?.group === group),
  })).filter((s) => s.items.length > 0);
  if (sections.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t`New asset`}
          title={t`New asset`}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {sections.map((s, i) => (
          <div key={s.group}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground">{s.label}</DropdownMenuLabel>
            {s.items.map((ty) => {
              const Icon = iconForType(ty.type_name);
              return (
                <DropdownMenuItem key={ty.type_name} onSelect={() => onNew(ty.type_name)}>
                  <Icon className="h-3.5 w-3.5" />
                  {ty.label}
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
