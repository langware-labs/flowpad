import { FSRef, TypeId, VFSPath } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SimpleFileManager } from '@src/components/simple-file-manager';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';

/**
 * A `.zip`, browsed as the folder it holds. The archive is extracted on mount
 * into the instance's temp preview area (backend `fs/extract_preview`) — the
 * extraction is the view's side effect, never the loader's.
 *
 * `path` is the zip's compute-node vpath or its plain machine path (local).
 */
export function ArchivePreview({ path }: { path: string }) {
  const parsed = VFSPath.parse(path);
  const typeId = parsed.typeId ?? LOCAL_COMPUTE_NODE;
  const zipPath = parsed.typeId ? parsed.machinePath : path;
  const typeKey = typeId.toString();
  const [root, setRoot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRoot(null);
    setError(null);
    new FSRef(zipPath, new TypeId(typeKey))
      .extractPreview()
      .then((dir) => {
        if (!cancelled) setRoot(dir);
      })
      .catch((err: unknown) => {
        console.error('[archive-preview] extract failed', err);
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [zipPath, typeKey]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4" />
        <Trans>Cannot open this archive: {error}</Trans>
      </div>
    );
  }
  if (!root) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <Trans>Extracting…</Trans>
      </div>
    );
  }
  return <ArchiveFolder root={root} typeId={typeId} />;
}

/** An extracted archive's folder in the explorer; a file opens via `navigation.openFile`. */
export function ArchiveFolder({ root, typeId = LOCAL_COMPUTE_NODE }: { root: string; typeId?: TypeId }) {
  const { navigation } = useDockNavigation();
  return (
    <div className="h-full" data-testid="archive-preview">
      <SimpleFileManager
        typeId={typeId}
        // Normalizes a Windows `C:\…` root to the explorer's `/C/…` form.
        initialPath={VFSPath.fromMachinePath(root, typeId).machinePath}
        onFileSelect={(file) => navigation.openFile(file)}
        className="h-full"
      />
    </div>
  );
}

export default ArchivePreview;
