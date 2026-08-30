import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';
import { DockPointerData } from '../models/DockPointer';

export interface IClaudeMd extends IEntity {
  name?: string;
  asset_ref?: string;
  file_path?: string;
  filename?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
  scope?: string;
}

// `implements IClaudeMd` only checks the class; it contributes no members, so every
// field declared solely on IClaudeMd read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ClaudeMd extends EntityMerge<IClaudeMd> {}

/** `CLAUDE.md` instruction file, scoped per project or user. */
@registerEntity
export class ClaudeMd extends APIEntity<ClaudeMd> implements IClaudeMd {
  static type: string = 'claude_md';

  name?: string;
  asset_ref?: string;
  file_path?: string;
  filename?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
  scope?: string;

  constructor(entity: Partial<IClaudeMd> = {}) {
    super(entity);
    this.name = entity.name;
    this.asset_ref = entity.asset_ref;
    this.file_path = entity.file_path;
    this.filename = entity.filename;
    this.asset_type = entity.asset_type;
    this.parent_path = entity.parent_path;
    this.vault_root = entity.vault_root;
    this.scope = entity.scope;
  }

  /** Default open target: the asset editor (URL-first navigate target). */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer('claude_md') ?? this.defaultDockPointer;
  }
}
