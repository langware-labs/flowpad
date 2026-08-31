import { APIEntity, registerEntity } from '../APIEntity';
import { dataContext } from '../FlowSync/context';
import { FSRef } from '../fs/FSRef';
import { DockPointerData } from '../models/DockPointer';

/**
 * UsageReport entity — a deterministic agentic-usage summary over a date range,
 * produced by the daily `builtin_daily_usage_analysis` trigger. The entity row
 * carries only the small headline fields the Home Feed card needs; the full
 * payload (breakdowns, sample prompts, the per-session drill-down spine, and the
 * rendered markdown) lives at `asset_ref`
 * (~/.claude/usage_reports/<name>/report.json) and the viewer streams it via FSRef.
 */
@registerEntity
export class UsageReport extends APIEntity<UsageReport> {
  static type: string = 'usage_report';

  period_start?: string;
  period_end?: string;
  period_kind: string = 'day';
  generated_at?: string;

  total_cost_usd: number = 0;
  session_count: number = 0;
  total_duration_ms: number = 0;
  total_tokens: number = 0;
  prompt_count: number = 0;
  skill_invocations: number = 0;
  agent_spawns: number = 0;
  cache_hit_rate: number = 0;
  asset_ref?: string;

  constructor(entity: Partial<UsageReport> = {}) {
    super(entity);
    this.period_start = entity.period_start;
    this.period_end = entity.period_end;
    this.period_kind = entity.period_kind ?? 'day';
    this.generated_at = entity.generated_at;
    this.total_cost_usd = entity.total_cost_usd ?? 0;
    this.session_count = entity.session_count ?? 0;
    this.total_duration_ms = entity.total_duration_ms ?? 0;
    this.total_tokens = entity.total_tokens ?? 0;
    this.prompt_count = entity.prompt_count ?? 0;
    this.skill_invocations = entity.skill_invocations ?? 0;
    this.agent_spawns = entity.agent_spawns ?? 0;
    this.cache_hit_rate = entity.cache_hit_rate ?? 0;
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
    return new FSRef(this.asset_ref, typeId);
  }
}
