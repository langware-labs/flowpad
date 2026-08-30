import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';
import { DockPointerData } from '../models/DockPointer';

export interface ICommand extends IEntity {
  name?: string;
  description?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
}

// `implements ICommand` only checks the class; it contributes no members, so every
// field declared solely on ICommand read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Command extends EntityMerge<ICommand> {}

/** Slash-command markdown file under `.claude/commands/*.md`. */
@registerEntity
export class Command extends APIEntity<Command> implements ICommand {
  static type: string = 'command';

  name?: string;
  description?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;

  constructor(entity: Partial<ICommand> = {}) {
    super(entity);
    this.name = entity.name;
    this.description = entity.description;
    this.asset_ref = entity.asset_ref;
    this.asset_type = entity.asset_type;
    this.parent_path = entity.parent_path;
    this.vault_root = entity.vault_root;
  }

  /** Default open target: the asset editor (URL-first navigate target). */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer('command') ?? this.defaultDockPointer;
  }
}
