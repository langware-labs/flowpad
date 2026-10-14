/**
 * AssetSetup — a declared node of the setup tree (flow_sdk/builtin/asset_setup.py):
 * `agentic-assets/asset_setup/<name>/asset_setup.json`. The row mirrors the document.
 */
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';

/** When a node's wizards fire, in order: before its children, once they are set up, when it is shown. */
export const SETUP_HOOKS = ['prepare', 'run', 'on_load'] as const;
export type SetupHook = (typeof SETUP_HOOKS)[number];

export interface IAssetSetup extends IEntity {
  name?: string;
  label?: string;
  subject?: string;
  children?: string[];
  prepare?: string;
  run?: string;
  on_load?: string;
  inputs?: Record<string, string>;
  project_id?: string | null;
}

export interface AssetSetup extends EntityMerge<IAssetSetup> {}

@registerEntity
export class AssetSetup extends APIEntity<AssetSetup> implements IAssetSetup {
  static type: string = 'asset_setup';

  name: string = '';
  label: string = '';
  subject: string = '';
  children: string[] = [];
  prepare: string = '';
  run: string = '';
  on_load: string = '';
  inputs: Record<string, string> = {};
  project_id: string | null = null;

  /** Re-apply the payload: class-field initializers run after `super(json)`. */
  constructor(json: IAssetSetup | undefined = undefined) {
    super(json as never);
    if (json) dataManager.deepAssign(this, json);
  }

  /** The wizard each hook fires, as a typeid — the copy the setup run would pick; null when the
   *  hook is empty or names no wizard (`GET asset_setup/<id>/hooks`). */
  async hooks(): Promise<Record<SetupHook, string | null>> {
    return dataManager.callAction<void, Record<SetupHook, string | null>>(
      new ActionInfo('hooks', AssetSetup.type, this.id, 'GET'),
    );
  }
}
