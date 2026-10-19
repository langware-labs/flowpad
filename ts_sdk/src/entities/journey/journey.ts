import { APIEntity, registerEntity } from '../../APIEntity';
import apiClient from '../../client';
import { dataContext } from '../../FlowSync/context';
import { dataManager } from '../../APIEntity';
import { ExpansionRequest } from '../../FlowSync/query';
import { FSRef } from '../../fs/FSRef';
import { DockPointerData } from '../../models/DockPointer';
import { IEntity, EntityMerge } from '../../IEntity';
import { JourneyGraph } from './journey-graph';
import { IJourneyJournal, JourneyJournal } from './journey-journal';

export interface IJourney extends IEntity {
  /** Owning project root resolved by the backend for this occurrence. */
  project_root?: string | null;
  asset_ref?: string;
  enabled?: boolean;
}

/** The file a journey's steps are authored in, inside its asset folder. */
const GRAPH_FILE = 'graph.json';


// `implements IJourney` only checks the class; it contributes no members, so every
// field declared solely on IJourney read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Journey extends EntityMerge<IJourney> {}

/**
 * A guided User Journey — a folder-backed onboarding document. Exposes the
 * journey interface (`launch` / `restart` / `advance` / `progress` / `history`,
 * plus static `resume`); every one resolves to the {@link JourneyJournal} that
 * IS the progress.
 *
 * The `auto_launch` flag lives in the journey's `graph.json` (disk is the
 * single source of truth); the loader asks the backend via `/auto-launch`
 * rather than reading a field here.
 *
 * The two methods that are NOT transport — {@link loadSteps} and
 * {@link projectRoot} — are the seams a journey with no folder overrides. Keep
 * them overridable and keep every caller going through them: that is what lets
 * `MemoryJourney` exist without the frontend knowing.
 */
@registerEntity
export class Journey extends APIEntity<Journey> implements IJourney {
  static type: string = 'journey';
  asset_ref?: string;
  enabled?: boolean;

  constructor(entity: Partial<IJourney> = {}) {
    super(entity);
    this.asset_ref = entity.asset_ref;
    this.project_root = entity.project_root;
    this.enabled = entity.enabled;
  }

  private get base(): string {
    return `/api/v1/journeys/${this.id}`;
  }

  /** FsRef for the journey's asset folder. Resolves compute node from
   *  dataContext — the same `doc` accessor DynamicWorkflow, AgentTrace and
   *  UsageReport expose over their own `asset_ref`. */
  get doc(): FSRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId || !this.asset_ref) return null;
    return new FSRef(this.asset_ref, typeId, 'folder');
  }

  /** One shared read per journey — see {@link loadSteps}. */
  private stepsPromise: Promise<JourneyGraph> | null = null;

  /**
   * The journey's steps, read from its folder's `graph.json` — disk is truth.
   *
   * This was a React hook doing an inline `FSRef` read, which is why a journey
   * could not have steps from anywhere else. Overriding this one method is the
   * whole of what a code-defined journey needs.
   *
   * Concurrent callers share ONE read: the tray and the journey viewer both
   * mount `useJourneySteps` for the same journey, and each was fetching the
   * same file independently.
   *
   * Neither the not-ready bail nor a failure is cached — a journey whose
   * compute node arrives after mount would otherwise be stuck with the empty
   * graph forever. An unreadable or malformed graph resolves to an EMPTY graph
   * rather than throwing: a journey whose file is missing should render as
   * "no steps", not take down the tray trying to show it.
   */
  async loadSteps(): Promise<JourneyGraph> {
    const folder = this.doc;
    if (!folder) return new JourneyGraph();
    this.stepsPromise ??= (async () => {
      const expanded = await dataManager.getByTypeId<Journey>(this.typeId, new ExpansionRequest({ expand: ['blobs'] }));
      this.project_root = expanded?.project_root ?? null;
      return JourneyGraph.parse(await folder.child(GRAPH_FILE).read());
    })().catch((e: unknown) => {
      console.error('[Journey] document read failed', e);
      this.stepsPromise = null;
      return new JourneyGraph();
    });
    return this.stepsPromise;
  }

  /** The backend-resolved owner of this occurrence, including custom placements. */
  get projectRoot(): string | null {
    return this.project_root ?? null;
  }

  /** The active journal, else the most recent one, else null (never launched). */
  async progress(): Promise<JourneyJournal | null> {
    const row = await apiClient.get<IJourneyJournal | null>(`${this.base}/progress`);
    return row ? new JourneyJournal(row) : null;
  }

  /** Idempotent — returns the active journal, or starts a fresh one at the entry. */
  /** Null when the backend refused the launch (capability gate closed —
   *  nothing left to set up — or the journey has no guided steps). */
  async launch(): Promise<JourneyJournal | null> {
    const data = await apiClient.post<IJourneyJournal | undefined>(`${this.base}/launch`);
    return data ? new JourneyJournal(data) : null;
  }

  /** Archive the active journal (→ `restarted`) and launch a fresh one. */
  async restart(): Promise<JourneyJournal> {
    return new JourneyJournal(await apiClient.post<IJourneyJournal>(`${this.base}/restart`));
  }

  /** Record a step outcome and move the cursor. Stale `nodeId` is a no-op. */
  async advance(nodeId: string, event: 'done' | 'skipped' = 'done'): Promise<JourneyJournal> {
    const row = await apiClient.post<IJourneyJournal>(`${this.base}/advance`, {
      node_id: nodeId,
      event,
    });
    return new JourneyJournal(row);
  }

  /** Every journal for this journey, newest-first — all statuses. */
  async history(): Promise<JourneyJournal[]> {
    const rows = await apiClient.get<IJourneyJournal[]>(`${this.base}/history`);
    return (rows ?? []).map((r) => new JourneyJournal(r));
  }

  /** Re-activate a past journal, archiving whichever one is active now. */
  static async resume(journalId: string): Promise<JourneyJournal> {
    const row = await apiClient.post<IJourneyJournal>('/api/v1/journeys/resume', {
      journal_id: journalId,
    });
    return new JourneyJournal(row);
  }

  /** Default open target: the journey overview viewer (not the markdown editor). */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? this.defaultDockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? super.editorDockPointer;
  }

}
