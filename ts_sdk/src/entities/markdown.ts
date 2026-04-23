import { fsManager } from '../services/fsService';

/**
 * MarkdownAsset — thin helper for quick-create of markdown assets.
 *
 * Markdown is not a first-class entity today (it's written directly to disk as a file).
 * This class provides a createInProject static so the quick-create registry can
 * treat it uniformly alongside Skill/Agent/Task/Workflow.
 */
export class MarkdownAsset {
  /**
   * Create a markdown file under `<project mount>/<folderVfsPath>/<safeName>.md`.
   * Defaults `folderVfsPath` to `.claude/docs`. Returns the final VFS path.
   */
  static async createInProject(
    project: { fs_storage_mount_path?: string } | null,
    name: string,
    folderVfsPath?: string,
  ): Promise<{ asset_ref: string }> {
    const { ComputeNode } = await import('./compute-node/compute-node');
    const computeNode = await ComputeNode.getById('@local');
    if (!computeNode) throw new Error('No local compute node');

    const mountPath = project?.fs_storage_mount_path ?? '';
    const vfsBase = mountPath.startsWith('/') ? mountPath.slice(1) : mountPath;
    const folder = (folderVfsPath ?? '.claude/docs').replace(/^\/+/, '').replace(/\/+$/, '');
    const safeName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const vfsPath = vfsBase ? `${vfsBase}/${folder}/${safeName}.md` : `${folder}/${safeName}.md`;

    const content = `---\ntitle: ${name.trim()}\n---\n\n# ${name.trim()}\n`;
    await fsManager.writeFile(computeNode.typeId, vfsPath, content);
    return { asset_ref: vfsPath };
  }
}
