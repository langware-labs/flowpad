import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { fsManager } from '../services/fsService';

export interface IMarkdown extends IEntity {
  name?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
  title?: string;
  tags?: string[];
  links?: string[];
  scope?: string;
}

/**
 * Markdown (Docs) entity — wiki/markdown files under `.claude/docs/*.md`.
 * Registered so `useEntitiesQuery({ type: 'markdown' })` materializes backend
 * rows into Markdown instances instead of silently dropping them.
 */
@registerEntity
export class Markdown extends APIEntity<Markdown> implements IMarkdown {
  static type: string = 'markdown';

  name?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
  title?: string;
  tags?: string[];
  links?: string[];
  scope?: string;

  constructor(entity: Partial<IMarkdown> = {}) {
    super(entity);
    this.name = entity.name;
    this.asset_ref = entity.asset_ref;
    this.asset_type = entity.asset_type;
    this.parent_path = entity.parent_path;
    this.vault_root = entity.vault_root;
    this.title = entity.title;
    this.tags = entity.tags;
    this.links = entity.links;
    this.scope = entity.scope;
  }
}

/**
 * MarkdownAsset — thin helper for quick-create of markdown assets.
 *
 * Separate from the `Markdown` entity class above because quick-create writes
 * a file to disk and returns the VFS path; it is not itself an Entity save.
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
