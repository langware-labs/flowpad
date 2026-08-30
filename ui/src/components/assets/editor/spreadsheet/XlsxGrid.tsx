import { useEffect, useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import { RevoGrid } from '@revolist/react-datagrid';
import * as XLSX from 'xlsx';
import type { FSRef } from '@sdk';
import { fsManager } from '@sdk';
import { matrixToGrid, type GridData } from './grid-data';

interface XlsxGridProps {
  /** FSRef to the .xlsx file (binary). */
  fsRef: FSRef;
  /** Entity `updated_date`-derived token — re-reads on out-of-band change. */
  reloadKey: string | number | undefined;
}

interface Workbook {
  // Keys are the sheet names in workbook order (insertion order preserved).
  gridBySheet: Record<string, GridData>;
}

/**
 * Read-only XLSX viewer. XLSX is binary, so it can't ride the plain-text
 * `useFSRefContent` path — we read the bytes directly via
 * `fsManager.download(..., { asBlob: true })`, parse with SheetJS, and render
 * each sheet in a RevoGrid (read-only) behind a sheet-tab switcher.
 *
 * Keyed on `[path, reloadKey]` so an out-of-band change (an agent turn-end
 * reindex bumps the entity's `updated_date` → `reloadKey`) re-reads the file.
 * No save path — the grid is read-only by design (SheetJS write would drop
 * styles/formulas/charts).
 */
export function XlsxGrid({ fsRef, reloadKey }: XlsxGridProps) {
  const { resolvedTheme } = useTheme();
  // RevoGrid ships light/dark as separate named themes; it won't follow the app's `dark` class.
  const gridTheme = resolvedTheme === 'dark' ? 'darkCompact' : 'compact';

  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const path = fsRef.path;
  const typeId = fsRef.typeId;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = async () => {
      try {
        const blob = await fsManager.download(typeId, path, { asBlob: true });
        const buf = blob instanceof Blob ? await blob.arrayBuffer()
          : new TextEncoder().encode(String(blob)).buffer;
        if (cancelled) return;
        const wb = XLSX.read(buf, { type: 'array' });
        const gridBySheet: Record<string, GridData> = {};
        for (const name of wb.SheetNames) {
          const ws = wb.Sheets[name];
          const matrix = XLSX.utils.sheet_to_json<string[]>(ws, {
            header: 1,
            raw: false,
            defval: '',
            blankrows: true,
          });
          gridBySheet[name] = matrixToGrid(matrix as string[][], /* readonly */ true);
        }
        if (cancelled) return;
        setWorkbook({ gridBySheet });
        setActiveSheet(wb.SheetNames[0] ?? null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
    // typeId is derived from the same fsRef as path; keying on path + reloadKey
    // is the stable signal (see useFSRefContent's path-keying rationale).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reloadKey]);

  const activeGrid = useMemo(
    () => (workbook && activeSheet ? workbook.gridBySheet[activeSheet] : null),
    [workbook, activeSheet],
  );

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-destructive">
        Failed to load workbook: {error}
      </div>
    );
  }
  if (loading || !workbook || !activeGrid) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  const sheetNames = Object.keys(workbook.gridBySheet);

  return (
    <div className="flex h-full w-full flex-col" data-testid="xlsx-grid">
      <div className="min-h-0 flex-1">
        <RevoGrid
          className="h-full w-full"
          columns={activeGrid.columns}
          source={activeGrid.source}
          readonly
          resize
          rowHeaders
          theme={gridTheme}
        />
      </div>
      {sheetNames.length > 1 && (
        <div className="flex flex-shrink-0 items-center gap-1 overflow-x-auto border-t px-2 py-1">
          {sheetNames.map((name) => (
            <button
              key={name}
              onClick={() => setActiveSheet(name)}
              data-testid={`xlsx-sheet-tab-${name}`}
              className={
                'flex-shrink-0 rounded px-2 py-0.5 text-xs ' +
                (name === activeSheet
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50')
              }
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
