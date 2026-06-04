import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { DockPointerData } from '../models/DockPointer';

export interface IClaudeMemory extends IEntity {
  name?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
  project_path?: string;
  project_encoded?: string;
}

/** Memory markdown file under `~/.claude/projects/<encoded>/memory/*.md`. */
@registerEntity
export class ClaudeMemory extends APIEntity<ClaudeMemory> implements IClaudeMemory {
  static type: string = 'claude_memory';

  name?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
  project_path?: string;
  project_encoded?: string;

  constructor(entity: Partial<IClaudeMemory> = {}) {
    super(entity);
    this.name = entity.name;
    this.asset_ref = entity.asset_ref;
    this.asset_type = entity.asset_type;
    this.parent_path = entity.parent_path;
    this.vault_root = entity.vault_root;
    this.project_path = entity.project_path;
    this.project_encoded = entity.project_encoded;
  }

  /** Default open target: the asset editor (URL-first navigate target). */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer('claude_memory') ?? super.dockPointer;
  }
}
