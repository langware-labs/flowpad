import type { EntityMerge } from '../IEntity';
import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IMarkdownIndex extends IEntity {
  name?: string;
  title?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
  inputs_hash?: string;
  template_version?: number;
  prompt_version?: number;
  parent_ref?: string;
  file_count?: number;
  subfolder_count?: number;
  latest_process_ref?: string;
}

// `implements IMarkdownIndex` only checks the class; it contributes no members, so every
// field declared solely on IMarkdownIndex read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MarkdownIndex extends EntityMerge<IMarkdownIndex> {}

/**
 * MarkdownIndex entity — single-file `index.md` representing a Merkle-tree
 * folder index. Frontmatter holds entity metadata; body is the human-readable
 * index. Rebuild runs as an AgenticProcess tagged
 * `context_data.kind = "markdown_index_rebuild"`.
 */
@registerEntity
export class MarkdownIndex extends APIEntity<MarkdownIndex> implements IMarkdownIndex {
  static type: string = 'markdown_index';

  name?: string;
  title?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
  inputs_hash?: string;
  template_version?: number;
  prompt_version?: number;
  parent_ref?: string;
  file_count?: number;
  subfolder_count?: number;
  latest_process_ref?: string;

  constructor(entity: Partial<IMarkdownIndex> = {}) {
    super(entity);
    this.name = entity.name;
    this.title = entity.title;
    this.asset_ref = entity.asset_ref;
    this.asset_type = entity.asset_type;
    this.parent_path = entity.parent_path;
    this.vault_root = entity.vault_root;
    this.inputs_hash = entity.inputs_hash;
    this.template_version = entity.template_version;
    this.prompt_version = entity.prompt_version;
    this.parent_ref = entity.parent_ref;
    this.file_count = entity.file_count;
    this.subfolder_count = entity.subfolder_count;
    this.latest_process_ref = entity.latest_process_ref;
  }
}
