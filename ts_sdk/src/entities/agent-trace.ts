import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { dataContext } from '../FlowSync/context';
import { FSRef } from '../fs/FSRef';
import { DockPointerData } from '../models/DockPointer';
import { TypeId } from '../models/TypeId';

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
    return this.assetEditorPointer('agent_trace') ?? super.dockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.assetEditorPointer('agent_trace') ?? super.editorDockPointer;
  }

  override get searchDockPointer(): DockPointerData {
    return this.assetEditorPointer('agent_trace') ?? this.dockPointer;
  }

  /**
   * A trace's human label is "Agent analysis: <the analyzed process's name>", so
   * its tab / header / search row reads as the analysis of a known session
   * rather than the opaque `trace-<id>` folder name. The trace only stores the
   * process id, so the name is resolved from the cached AgenticProcess; until
   * that row is in cache we return null and defer to the default `trace-<id>`.
   */
  override getDisplayName(): string | null {
    const pid = this.analyzed_process_id;
    if (!pid) return null;
    try {
      const proc = dataManager.getByTypeIdFromCache(new TypeId('agentic_process', pid)) as
        | { displayName?: string | null; name?: string | null }
        | null;
      const name = (proc?.displayName ?? proc?.name)?.trim();
      return name ? `Agent analysis: ${name}` : null;
    } catch {
      return null;
    }
  }

  /** FsRef for trace.json. Resolves compute node from dataContext. */
  get doc(): FSRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId || !this.asset_ref) return null;
    return new FSRef(this.asset_ref, typeId);
  }
}
