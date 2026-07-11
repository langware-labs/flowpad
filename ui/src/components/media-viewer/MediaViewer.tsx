import { VFSPath } from '@sdk';
import { AlertCircle } from 'lucide-react';
import { useMemo } from 'react';
import { useFS } from '@src/hooks/useFS';
import { useProject } from '@src/hooks/useProject';

/**
 * Render an image/video/audio file inline via the backend fs `download`
 * action URL (streams raw bytes with the right MIME + inline disposition) —
 * never through FSRef.read(), which is text-only. Accepts both path forms the
 * asset-editor grammar produces: a compute-node vpath
 * (`compute_node-@local/<rel>`) and a plain machine path.
 */
export function MediaViewer({ path, kind }: { path: string; kind: 'image' | 'video' | 'audio' }) {
  const { project } = useProject();
  const parsed = useMemo(() => VFSPath.parse(path), [path]);
  const typeId = parsed.typeId ?? project?.typeId;
  const subPath = useMemo(() => {
    if (!parsed.typeId) return path;
    return parsed.entitySubPath.startsWith('/') ? parsed.entitySubPath : `/${parsed.entitySubPath}`;
  }, [parsed.typeId, parsed.entitySubPath, path]);
  const fs = useFS(typeId);
  const url = fs && subPath ? fs.getDownloadUrl(subPath) : null;

  if (!url) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4" />
        Cannot resolve media source: {path}
      </div>
    );
  }
  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-background p-4">
      {kind === 'image' && (
        <img
          src={url}
          alt={subPath ?? path}
          className="max-h-full max-w-full object-contain"
          data-testid="media-viewer-image"
        />
      )}
      {kind === 'video' && (
        <video src={url} controls className="max-h-full max-w-full" data-testid="media-viewer-video" />
      )}
      {kind === 'audio' && <audio src={url} controls className="w-full max-w-xl" data-testid="media-viewer-audio" />}
    </div>
  );
}

export default MediaViewer;
