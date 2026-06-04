import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { DockPointerData } from '../models/DockPointer';

export interface IPlan extends IEntity {
  name?: string;
  description?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
}

/**
 * Plan — a markdown plan document under ~/.claude/plans/.
 * Registered so `useEntitiesQuery({ type: 'plan' })` hydrates plan records
 * into real entity instances (not skipped by DataManager).
 */
@registerEntity
export class Plan extends APIEntity<Plan> implements IPlan {
  static type: string = 'plan';

  name?: string;
  description?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;

  constructor(entity: Partial<IPlan> = {}) {
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
    return this.assetEditorPointer('plan') ?? super.dockPointer;
  }
}
