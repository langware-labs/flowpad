import React, { useCallback, useState } from 'react';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import { useAssetSearch } from '@src/hooks/use-asset-search';
import { DEFAULT_ASSET_FILTER } from '@src/components/assets/assetFilter';
import * as lucideIcons from 'lucide-react';
import { CheckCircle2, File, Loader2, Plus, RefreshCw } from 'lucide-react';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { RecordType } from '@sdk';

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
  creatableTypes?: Set<string>;
}

export function AssetTypeSidebar({ selected, onSelect, onNew, creatableTypes }: Props) {
  const { types: allTypes, isLoading } = useAssetTypes();
  const HIDDEN_TYPES = new Set([RecordType.ASSET, RecordType.ANNOTATION]);
  const types = allTypes.filter(t => !HIDDEN_TYPES.has(t.type_name));
  const { indexType } = useSystemTools();
  const [scanningTypes, setScanningTypes] = useState<Set<string>>(new Set());
  const [doneTypes, setDoneTypes] = useState<Record<string, number>>({});

  const handleScan = useCallback(async (typeName: string) => {
    setScanningTypes(prev => new Set(prev).add(typeName));
    try {
      const result = await indexType(typeName);
      setDoneTypes(prev => ({ ...prev, [typeName]: result?.indexed ?? 0 }));
      setTimeout(() => {
        setDoneTypes(prev => { const next = { ...prev }; delete next[typeName]; return next; });
      }, 2000);
    } finally {
      setScanningTypes(prev => { const next = new Set(prev); next.delete(typeName); return next; });
    }
  }, [indexType]);

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

        const isScanning = scanningTypes.has(t.type_name);
        const isDone = doneTypes[t.type_name] !== undefined;

        return (
          <div key={t.type_name} className="flex flex-col">
            <div className="group flex items-center">
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
              <button
                onClick={(e) => { e.stopPropagation(); void handleScan(t.type_name); }}
                disabled={isScanning}
                className="ml-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
                title="Scan for changes"
              >
                <RefreshCw className={`h-3 w-3 ${isScanning ? 'animate-spin' : ''}`} />
              </button>
              {onNew && (!creatableTypes || creatableTypes.has(t.type_name)) && (
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
            <div className={`overflow-hidden transition-all duration-300 ${
              isScanning || isDone ? 'max-h-7 opacity-100' : 'max-h-0 opacity-0'
            }`}>
              <div className="flex items-center gap-1.5 px-2 pb-1 text-xs text-muted-foreground">
                {isScanning ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>Scanning…</span>
                  </>
                ) : isDone ? (
                  <>
                    <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {doneTypes[t.type_name].toLocaleString()} indexed
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
