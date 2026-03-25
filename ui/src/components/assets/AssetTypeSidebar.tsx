import React from 'react';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import { useAssetSearch } from '@src/hooks/use-asset-search';
import { DEFAULT_ASSET_FILTER } from '@src/components/assets/assetFilter';
import * as lucideIcons from 'lucide-react';
import { File, Loader2, Plus } from 'lucide-react';

function TypeCount({ typeName }: { typeName: string }) {
  const { total, isLoading } = useAssetSearch({ recordType: typeName, filter: DEFAULT_ASSET_FILTER, page: 1, pageSize: 1 });
  if (isLoading) return null;
  if (!total) return null;
  return (
    <span className="ml-auto mr-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {total > 999 ? '999+' : total}
    </span>
  );
}

interface Props {
  selected: string | null;
  onSelect: (typeName: string) => void;
  onNew?: (typeName: string) => void;
}

export function AssetTypeSidebar({ selected, onSelect, onNew }: Props) {
  const { types, isLoading } = useAssetTypes();

  if (isLoading) {
    return (
      <div className="flex h-20 items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2">
      {types.map((t) => {
        // Resolve Lucide icon by name
        const iconName = t.icon as keyof typeof lucideIcons | null;
        const Icon = (iconName && iconName in lucideIcons
          ? (lucideIcons[iconName] as React.FC<React.SVGProps<SVGSVGElement>>)
          : File) as React.FC<{ className?: string }>;

        return (
          <div key={t.type_name} className="group flex items-center">
            <button
              onClick={() => onSelect(t.type_name)}
              className={`flex flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
                selected === t.type_name
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              <span className="truncate">{t.label}</span>
              <TypeCount typeName={t.type_name} />
            </button>
            {onNew && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onNew(t.type_name);
                }}
                className="ml-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
                title={`New ${t.label}`}
              >
                <Plus className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
