import { useCallback, useMemo, useState } from 'react';
import type { FSRef, Spreadsheet } from '@sdk';
import { AssetEditorHeader } from '../AssetEditorHeader';
import { entityReloadKey } from '@src/utils/entity-reload-key';
import { CsvGrid } from './CsvGrid';
import { XlsxGrid } from './XlsxGrid';

interface SpreadsheetAssetEditorProps {
  /** FSRef to the .csv/.xlsx file. */
  fsRef: FSRef;
  /** Resolved backing entity (from EntityResolutionGate). */
  spreadsheet: Spreadsheet;
}

function fmtOf(spreadsheet: Spreadsheet, path: string): 'csv' | 'xlsx' {
  const declared = (spreadsheet.format || '').toLowerCase();
  if (declared === 'xlsx' || declared === 'csv') return declared;
  return path.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
}

/**
 * Spreadsheet grid editor. CSV is editable (autosaved through the plain-text FS
 * path); XLSX is a read-only multi-sheet viewer. Both re-read on an out-of-band
 * change via the entity's `updated_date` → `reloadKey`, so an agent editing the
 * file in a vibe session refreshes the grid (the dirty-guard in `useFSRefContent`
 * holds unsaved local CSV edits until saved).
 */
export function SpreadsheetAssetEditor({ fsRef, spreadsheet }: SpreadsheetAssetEditorProps) {
  const path = fsRef.path;
  const format = fmtOf(spreadsheet, path);
  const reloadKey = entityReloadKey(
    (spreadsheet as { updated_date?: unknown }).updated_date,
  );
  const [dirty, setDirty] = useState(false);

  const { fileName, dirPath } = useMemo(() => {
    const idx = path.lastIndexOf('/');
    return {
      fileName: idx >= 0 ? path.slice(idx + 1) : path,
      dirPath: idx > 0 ? path.slice(0, idx) : '',
    };
  }, [path]);

  const onOpenExternal = useCallback(() => {
    void fsRef.open();
  }, [fsRef]);
  const onRevealInFinder = useCallback(() => {
    void fsRef.open({ select: true });
  }, [fsRef]);

  const readonlyBadge =
    format === 'xlsx' ? (
      <span
        className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
        title="XLSX is opened read-only — edit the source in a spreadsheet app, or export to CSV to edit here."
        data-testid="xlsx-readonly-badge"
      >
        Read-only
      </span>
    ) : null;

  return (
    <div className="flex h-full w-full flex-col">
      <AssetEditorHeader
        fileName={fileName}
        dirPath={dirPath}
        sourcePath={path}
        dirty={format === 'csv' ? dirty : undefined}
        onOpenExternal={onOpenExternal}
        onRevealInFinder={onRevealInFinder}
        actions={readonlyBadge}
      />
      <div className="min-h-0 flex-1">
        {format === 'csv' ? (
          <CsvGrid fsRef={fsRef} reloadKey={reloadKey} onDirtyChange={setDirty} />
        ) : (
          <XlsxGrid fsRef={fsRef} reloadKey={reloadKey} />
        )}
      </div>
    </div>
  );
}
