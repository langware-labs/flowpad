import { APIEntity, registerEntity } from '../APIEntity';
import { dataContext } from '../FlowSync/context';
import { FSRef } from '../fs/FSRef';
import { DockPointerData } from '../models/DockPointer';
import { mainFileForType } from '../models/asset-editor';

/**
 * AgentTrace entity — the analyzed timeline of one agentic execution,
 * produced by the agent-trace skill. The entity row carries only the small
 * summary fields (verdict banner answers "did it go well" instantly); the
 * full trace JSON lives at `asset_ref`
 * (~/.claude/agent_traces/<name>/trace.json) and viewers stream it via FSRef.
 */
@registerEntity
export class AgentTrace extends APIEntity<AgentTrace> {
  static type: string = 'agent_trace';

  session_id: string = '';
  worker_type: string = 'claude';
  analyzed_process_id?: string | null;
  verdict?: string;
  verdict_reason?: string;
  duration_ms?: number;
  cost_usd?: number;
  issue_count: number = 0;
  divergence_count: number = 0;
  lane_count: number = 1;
  asset_ref?: string;

  constructor(entity: Partial<AgentTrace> = {}) {
    super(entity);
    this.session_id = entity.session_id ?? '';
    this.worker_type = entity.worker_type ?? 'claude';
    this.analyzed_process_id = entity.analyzed_process_id ?? null;
    this.verdict = entity.verdict;
    this.verdict_reason = entity.verdict_reason;
    this.duration_ms = entity.duration_ms;
    this.cost_usd = entity.cost_usd;
    this.issue_count = entity.issue_count ?? 0;
    this.divergence_count = entity.divergence_count ?? 0;
    this.lane_count = entity.lane_count ?? 1;
    this.asset_ref = entity.asset_ref;
  }

  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? this.defaultDockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? super.editorDockPointer;
  }


  /** FsRef for trace.json. Resolves compute node from dataContext. */
  get doc(): FSRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId || !this.asset_ref) return null;
    // `asset_ref` is the folder; a row from before the unification may still
    // name the inner file, so append only when it is not already there.
    const base = this.asset_ref.replace(/\\/g, '/').replace(/\/+$/, '');
    const main = mainFileForType(AgentTrace.type, 'trace.json') as string;
    return new FSRef(base.endsWith(`/${main}`) ? base : `${base}/${main}`, typeId);
  }
}
