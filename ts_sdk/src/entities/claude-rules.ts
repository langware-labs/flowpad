import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { DockPointerData } from '../models/DockPointer';

export interface IClaudeRules extends IEntity {
  name?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
}

/** Rules markdown file under `.claude/rules/*.md`. */
@registerEntity
export class ClaudeRules extends APIEntity<ClaudeRules> implements IClaudeRules {
  static type: string = 'claude_rules';

  name?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;

  constructor(entity: Partial<IClaudeRules> = {}) {
    super(entity);
    this.name = entity.name;
    this.asset_ref = entity.asset_ref;
    this.asset_type = entity.asset_type;
    this.parent_path = entity.parent_path;
    this.vault_root = entity.vault_root;
  }

  /** Default open target: the asset editor (URL-first navigate target). */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer('claude_rules') ?? super.dockPointer;
  }
}
