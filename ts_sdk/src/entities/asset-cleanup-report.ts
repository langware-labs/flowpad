import { APIEntity, registerEntity } from '../APIEntity';
import { dataContext } from '../FlowSync/context';
import { FSRef } from '../fs/FSRef';
import { DockPointerData } from '../models/DockPointer';
import { mainFileForType } from '../models/asset-editor';

/**
 * AssetCleanupReport entity — a garbage-asset scan summary produced by the
 * asset-cleanup flow (the `asset_cleanup` haiku agent classifying skills and
 * agents under the scan roots). The entity row carries only the headline
 * counts the Home Feed card needs; the full payload (per-finding verdicts +
 * rendered markdown) lives at `asset_ref`
 * (~/.claude/cleanup_reports/<name>/report.json) and the viewer streams it via FSRef.
 */
@registerEntity
export class AssetCleanupReport extends APIEntity<AssetCleanupReport> {
  static type: string = 'asset_cleanup_report';

  generated_at?: string;
  root_count: number = 0;
  finding_count: number = 0;
  garbage_count: number = 0;
  keep_count: number = 0;
  unsure_count: number = 0;
  session_id?: string;
  asset_ref?: string;

  constructor(entity: Partial<AssetCleanupReport> = {}) {
    super(entity);
    this.generated_at = entity.generated_at;
    this.root_count = entity.root_count ?? 0;
    this.finding_count = entity.finding_count ?? 0;
    this.garbage_count = entity.garbage_count ?? 0;
    this.keep_count = entity.keep_count ?? 0;
    this.unsure_count = entity.unsure_count ?? 0;
    this.session_id = entity.session_id;
    this.asset_ref = entity.asset_ref;
  }

  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? this.defaultDockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? super.editorDockPointer;
  }


  /** FsRef for report.json. Resolves compute node from dataContext. */
  get doc(): FSRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId || !this.asset_ref) return null;
    // `asset_ref` is the folder; a row from before the unification may still
    // name the inner file, so append only when it is not already there.
    const base = this.asset_ref.replace(/\\/g, '/').replace(/\/+$/, '');
    const main = mainFileForType(AssetCleanupReport.type, 'report.json') as string;
    return new FSRef(base.endsWith(`/${main}`) ? base : `${base}/${main}`, typeId);
  }
}
