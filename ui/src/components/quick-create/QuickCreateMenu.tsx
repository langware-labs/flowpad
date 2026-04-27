import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { QUICK_CREATE_REGISTRY } from './registry';

interface QuickCreateMenuProps {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (type: string) => void;
}

/**
 * Dropdown menu listing creatable entity types. The list is the intersection of
 * the UI quick-create registry and the server-reported `creatable` types (so the
 * server stays authoritative for what's actually supported).
 */
export function QuickCreateMenu({ children, open, onOpenChange, onPick }: QuickCreateMenuProps) {
  const { types: serverTypes } = useAssetTypes();

  const items = useMemo(() => {
    const serverCreatable = new Set(
      serverTypes.filter((t) => t.creatable).map((t) => t.type_name),
    );
    // When server list is empty (still loading / older backend), fall back to the
    // full UI registry — it's the best-effort source of truth.
    const enforce = serverCreatable.size > 0;
    return QUICK_CREATE_REGISTRY.filter((d) => !enforce || serverCreatable.has(d.type)).map((d) => {
      const label = serverTypes.find((t) => t.type_name === d.type)?.label ?? d.label;
      return { ...d, displayLabel: label };
    });
  }, [serverTypes]);

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-56">
        <DropdownMenuLabel>Create new…</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((item) => {
          const Icon = item.Icon;
          return (
            <DropdownMenuItem
              key={item.type}
              onSelect={() => {
                onOpenChange(false);
                onPick(item.type);
              }}
            >
              <Icon className="mr-2 h-4 w-4" />
              {item.displayLabel}
            </DropdownMenuItem>
          );
        })}
        {items.length === 0 && (
          <DropdownMenuItem disabled>No creatable types available</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
