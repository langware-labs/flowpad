import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IClaudeMemory extends IEntity {
  name?: string;
  source_path?: string;
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
  source_path?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
  project_path?: string;
  project_encoded?: string;

  constructor(entity: Partial<IClaudeMemory> = {}) {
    super(entity);
    this.name = entity.name;
    this.source_path = entity.source_path;
    this.asset_type = entity.asset_type;
    this.parent_path = entity.parent_path;
    this.vault_root = entity.vault_root;
    this.project_path = entity.project_path;
    this.project_encoded = entity.project_encoded;
  }
}
