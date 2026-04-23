import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IClaudeRules extends IEntity {
  name?: string;
  source_path?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
}

/** Rules markdown file under `.claude/rules/*.md`. */
@registerEntity
export class ClaudeRules extends APIEntity<ClaudeRules> implements IClaudeRules {
  static type: string = 'claude_rules';

  name?: string;
  source_path?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;

  constructor(entity: Partial<IClaudeRules> = {}) {
    super(entity);
    this.name = entity.name;
    this.source_path = entity.source_path;
    this.asset_type = entity.asset_type;
    this.parent_path = entity.parent_path;
    this.vault_root = entity.vault_root;
  }
}
