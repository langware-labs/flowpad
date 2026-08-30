import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';
import { DockPointerData } from '../models/DockPointer';

export interface IClaudeRules extends IEntity {
  name?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
}

// `implements IClaudeRules` only checks the class; it contributes no members, so every
// field declared solely on IClaudeRules read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ClaudeRules extends EntityMerge<IClaudeRules> {}

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
    return this.assetEditorPointer('claude_rules') ?? this.defaultDockPointer;
  }
}
