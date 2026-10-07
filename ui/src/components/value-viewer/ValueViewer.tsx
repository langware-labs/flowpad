import { FSRef, VFSPath } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import { useFSRefContent } from '@src/hooks/use-fs-ref-content';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { KindValue } from './KindValue';

/** A value file's content: the value, and the kind it carries in its `spec_kind` (a dump's tag). */
export function readValue(raw: unknown): { kind: string; value: unknown } {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a value: expected an object');
  const { spec_kind: kind, ...value } = parsed as Record<string, unknown>;
  if (typeof kind !== 'string' || !kind) throw new Error('the file names no spec_kind');
  return { kind, value };
}

function parsed(content: string): { kind: string; value: unknown } | { error: string } {
  try {
    return readValue(content);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A `.value.json` — one value of a kind (a diagnosis a helper was sent, an eval run), shown by
 * that kind's viewer (`createViewerContext`, the data-viewer registry), the generic one else.
 * The file is read on mount — the view's work, never the loader's.
 *
 * `path` is the file's compute-node vpath or its plain machine path (local).
 */
export function ValueViewer({ path }: { path: string }) {
  const fsRef = useMemo(() => {
    const vpath = VFSPath.parse(path);
    return new FSRef(vpath.typeId ? vpath.machinePath : path, vpath.typeId ?? LOCAL_COMPUTE_NODE);
  }, [path]);
  const { content, isLoading, loadError, isMissing } = useFSRefContent(fsRef, { autoSave: false });
  const shown = useMemo(() => (isLoading || loadError || isMissing ? null : parsed(content)), [content, isLoading, loadError, isMissing]);
  const error = loadError?.message ?? (isMissing ? `${path} is missing` : shown && 'error' in shown ? shown.error : null);

  return (
    <div className="h-full overflow-auto p-4" data-testid="value-viewer">
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <Trans>Loading…</Trans>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <AlertCircle className="h-4 w-4" />
          <Trans>Cannot show this file: {error}</Trans>
        </div>
      )}
      {shown && 'kind' in shown && <KindValue kind={shown.kind} value={shown.value} />}
    </div>
  );
}
