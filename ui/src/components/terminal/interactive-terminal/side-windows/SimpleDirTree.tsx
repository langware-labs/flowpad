import { type TypeId } from '@sdk';
import { CornerLeftUp, File as FileIcon, Folder, RefreshCw } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { useFS } from '@src/hooks/useFS';

interface SimpleDirTreeProps {
  computeNodeTypeId: TypeId;
  /** Highest level the user can navigate up to. ".." is hidden when at this path. */
  topLevel: string;
  /** Initial directory to show. Defaults to topLevel. Must be at or under topLevel. */
  initialPath?: string;
  onSelectFile?: (absPath: string) => void;
}

function normalize(path: string): string {
  if (!path) return '/';
  const collapsed = path.replace(/\/+/g, '/');
  if (collapsed === '/') return '/';
  return collapsed.replace(/\/$/, '');
}

function parentOf(path: string): string {
  const normalized = normalize(path);
  if (normalized === '/') return '/';
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normalized.slice(0, idx);
}

function joinPath(dir: string, name: string): string {
  const base = normalize(dir);
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

export const SimpleDirTree: React.FC<SimpleDirTreeProps> = ({
  computeNodeTypeId,
  topLevel,
  initialPath,
  onSelectFile,
}) => {
  const fs = useFS(computeNodeTypeId);
  const fsRef = React.useRef(fs);
  fsRef.current = fs;

  const normalizedTop = useMemo(() => normalize(topLevel), [topLevel]);
  const [currentPath, setCurrentPath] = useState<string>(() => normalize(initialPath ?? topLevel));

  const atTop = currentPath === normalizedTop;
  const browseResult = fs?.browse(currentPath);
  const items = browseResult?.items ?? [];

  // Fetch on first visit to a path (cache-miss). listDirectory dedupes
  // concurrent calls, so spurious fires are cheap.
  useEffect(() => {
    if (browseResult) return;
    void fsRef.current?.listDirectory(currentPath);
  }, [browseResult, currentPath]);

  const handleRefresh = () => {
    fs?.invalidate(currentPath, 'browse');
  };

  const handleUp = () => {
    if (atTop) return;
    setCurrentPath(parentOf(currentPath));
  };

  const handleEnter = (item: { name: string; is_dir?: boolean; vfs_abs_path?: string }) => {
    const childPath = joinPath(currentPath, item.name);
    if (item.is_dir) {
      setCurrentPath(childPath);
    } else {
      onSelectFile?.(item.vfs_abs_path ?? childPath);
    }
  };

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const aDir = a.is_dir ? 0 : 1;
      const bDir = b.is_dir ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name);
    });
  }, [items]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="truncate text-xs text-muted-foreground" title={currentPath}>
          {currentPath}
        </span>
        <Button variant="ghost" size="sm" onClick={handleRefresh} className="h-6 w-6 shrink-0 p-0">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-1">
        <div className="flex flex-col">
          <button
            type="button"
            onClick={handleRefresh}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
            title="Current directory (click to refresh)"
          >
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="font-mono">.</span>
          </button>

          {!atTop && (
            <button
              type="button"
              onClick={handleUp}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
              title="Parent directory"
            >
              <CornerLeftUp className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="font-mono">..</span>
            </button>
          )}

          {sortedItems.map((item) => (
            <button
              key={item.name}
              type="button"
              onClick={() => handleEnter(item)}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
              title={item.name}
            >
              {item.is_dir ? (
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{item.name}</span>
            </button>
          ))}

          {sortedItems.length === 0 && browseResult && (
            <p className="mt-4 px-2 text-center text-xs text-muted-foreground">empty</p>
          )}
        </div>
      </div>
    </div>
  );
};
