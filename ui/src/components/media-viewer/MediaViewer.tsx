import { AssetEditor, VFSPath } from '@sdk';
import { AlertCircle } from 'lucide-react';
import { useFS } from '@src/hooks/useFS';
import { useProject } from '@src/hooks/useProject';

/**
 * Render an image/video/audio file inline via the backend fs `download`
 * action URL (streams raw bytes with the right MIME + inline disposition) —
 * never through FSRef.read(), which is text-only. Accepts both path forms the
 * asset-editor grammar produces: a compute-node vpath
 * (`compute_node-@local/<rel>`) and a plain machine path.
 */
export function MediaViewer({
  path,
  kind,
}: {
  path: string;
  kind: AssetEditor.IMAGE | AssetEditor.VIDEO | AssetEditor.AUDIO;
}) {
  const { project } = useProject();
  const parsed = VFSPath.parse(path);
  const typeId = parsed.typeId ?? project?.typeId;
  const subPath = parsed.typeId ? parsed.machinePath : path;
  const fs = useFS(typeId);
  const url = fs ? fs.getDownloadUrl(subPath) : null;

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
      {kind === AssetEditor.IMAGE && (
        <img src={url} alt={subPath} className="max-h-full max-w-full object-contain" data-testid="media-viewer-image" />
      )}
      {kind === AssetEditor.VIDEO && (
        <video src={url} controls className="max-h-full max-w-full" data-testid="media-viewer-video" />
      )}
      {kind === AssetEditor.AUDIO && <audio src={url} controls className="w-full max-w-xl" data-testid="media-viewer-audio" />}
    </div>
  );
}

export default MediaViewer;
