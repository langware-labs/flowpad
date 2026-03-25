import { Button } from '@src/components/ui/button';
import { ExternalLink, Save } from 'lucide-react';
import React from 'react';

interface AssetToolbarProps {
  title: string;
  sourcePath?: string;
  isDirty: boolean;
  isSaving: boolean;
  onSave: () => void;
  onOpenExternal: () => void;
  children?: React.ReactNode;
}

export function AssetToolbar({ title, sourcePath, isDirty, isSaving, onSave, onOpenExternal, children }: AssetToolbarProps) {
  return (
    <div className="flex h-[52px] flex-shrink-0 items-center justify-between border-b bg-muted/50 px-3">
      <div className="flex min-w-0 flex-col justify-center">
        <h3 className="truncate text-sm font-medium leading-tight">{title}</h3>
        {sourcePath && (
          <span className="truncate text-xs text-muted-foreground/60 leading-tight">{sourcePath}</span>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-2 pl-2">
        {children}
        {isDirty && (
          <Button size="sm" onClick={onSave} disabled={isSaving}>
            <Save className={`mr-1 h-4 w-4 ${isSaving ? 'animate-pulse' : ''}`} />
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onOpenExternal} title="Open in external editor">
          <ExternalLink className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
