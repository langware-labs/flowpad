import { VFSPath } from '@sdk';
import { useFS } from '@src/hooks/useFS';
import { useProject } from '@src/hooks/useProject';

/**
 * Resolve a raw asset path to its backend fs `download` action URL. Accepts both
 * path forms the asset-editor grammar produces: a compute-node vpath
 * (`compute_node-@local/<rel>`) and a plain machine path; falls back to the
 * current project's compute node when the path carries no typeid. Shared by the
 * inline byte viewers (MediaViewer, PdfViewer). Returns `url: null` when no fs is
 * resolvable, so callers can render a "cannot resolve source" fallback.
 */
export function useDownloadUrl(path: string): { url: string | null; subPath: string } {
  const { project } = useProject();
  const parsed = VFSPath.parse(path);
  const typeId = parsed.typeId ?? project?.typeId;
  const subPath = parsed.typeId ? parsed.machinePath : path;
  const fs = useFS(typeId);
  return { url: fs ? fs.getDownloadUrl(subPath) : null, subPath };
}
