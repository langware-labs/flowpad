import { useCallback, useEffect, useRef, useState } from 'react';
import { RevoGrid } from '@revolist/react-datagrid';
import type { DataType } from '@revolist/react-datagrid';
import type { FSRef } from '@sdk';
import { useFSRefContent } from '@src/hooks/use-fs-ref-content';
import {
  applyEditToSource,
  parseCsvToGrid,
  serializeGridToCsv,
  type GridData,
} from './grid-data';

const EMPTY_GRID: GridData = { columns: [], source: [] };

interface CsvGridProps {
  /** FSRef to the .csv file (read/write string content). */
  fsRef: FSRef;
  /** Entity `updated_date`-derived token — re-reads on out-of-band change. */
  reloadKey: string | number;
  /** Reports dirty state up to the header. */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * Editable CSV grid. Loads/saves the file as plain text through
 * `useFSRefContent` (autosave + the `reloadKey` external-refresh guard), and
 * renders/edits it via RevoGrid.
 *
 * Load/edit decoupling: the parse effect rebuilds the grid only when `content`
 * changes from a LOAD or external reload — never from our own edit echo
 * (guarded by `lastSerializedRef`), so a keystroke doesn't tear down the grid
 * and steal focus. Mirrors the whiteboard's `lastWrittenRef` guard.
 */
export function CsvGrid({ fsRef, reloadKey, onDirtyChange }: CsvGridProps) {
  const { content, setContent, dirty, isLoading, loadError } = useFSRefContent(fsRef, {
    autoSave: true,
    autoSaveMs: 1500,
    reloadKey,
  });

  const [grid, setGrid] = useState<GridData>(EMPTY_GRID);
  // The array RevoGrid renders + mutates; also our serialization source.
  const sourceRef = useRef<DataType[]>([]);
  // The last CSV WE serialized — so the parse effect can skip our own echo.
  const lastSerializedRef = useRef<string | null>(null);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (isLoading) return;
    if (content === lastSerializedRef.current) return; // own-edit echo — keep grid/focus
    const g = parseCsvToGrid(content);
    sourceRef.current = g.source;
    setGrid(g);
  }, [content, isLoading]);

  const handleAfterEdit = useCallback(
    (e: CustomEvent) => {
      applyEditToSource(sourceRef.current, e.detail);
      const csv = serializeGridToCsv(grid.columns, sourceRef.current);
      lastSerializedRef.current = csv;
      setContent(csv);
    },
    [grid.columns, setContent],
  );

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-destructive">
        Failed to load spreadsheet: {loadError.message}
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="h-full w-full" data-testid="csv-grid">
      <RevoGrid
        className="h-full w-full"
        columns={grid.columns}
        source={grid.source}
        resize
        rowHeaders
        range
        theme="compact"
        onAfteredit={handleAfterEdit}
      />
    </div>
  );
}
