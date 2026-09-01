import { FSRef } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';
import type { ReactNode } from 'react';

interface ReportAssetShellProps {
  fsRef: FSRef;
  /** Display name from the report entity; falls back to the file's basename. */
  name?: string | null;
  testId: string;
  loading: boolean;
  error?: string | null;
  /** Rendered once the document has resolved. */
  children: ReactNode;
}

/**
 * Chrome shared by the JSON-document asset editors (usage report, asset-cleanup
 * report, MCP server): the header derived from the FSRef path, the scrolling
 * body, and the loading / load-error states. Each editor supplies only its own
 * body.
 *
 * The strings are document-neutral on purpose — an MCP server is not a report,
 * and this shell is named for the two editors that happened to need it first.
 */
export function ReportAssetShell({ fsRef, name, testId, loading, error, children }: ReportAssetShellProps) {
  const fileName = fsRef.path.split('/').pop() ?? '';
  const dirPath = fsRef.path.slice(0, -fileName.length - 1);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={testId}>
      <AssetEditorHeader fileName={name || fileName} dirPath={dirPath} />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading && (
          <p className="text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        )}
        {error && (
          <p className="text-sm text-destructive">
            <Trans>Failed to load: {error}</Trans>
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
