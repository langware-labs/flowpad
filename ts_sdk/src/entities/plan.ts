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

// `implements IPlan` only checks the class; it contributes no members, so every
// field declared solely on IPlan read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Plan extends Omit<IPlan, 'expand' | 'id' | 'is_private' | 'members'> {}

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
    return this.assetEditorPointer('plan') ?? this.defaultDockPointer;
  }
}
