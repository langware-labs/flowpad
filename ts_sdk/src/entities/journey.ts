import { APIEntity, registerEntity } from '../APIEntity';
import apiClient from '../client';
import { DockPointerData } from '../models/DockPointer';
import { IEntity } from '../IEntity';

/** new → launched → complete, plus `restarted` for a superseded journal. */
export type JourneyStatus = 'new' | 'launched' | 'complete' | 'restarted';

/** One recorded step transition inside a journal. */
export interface JourneyJournalEntry {
  node_id: string;
  event: string;
  at?: string;
}

export interface IJourneyJournal extends IEntity {
  journey_id?: string;
  user_id?: string;
  status?: JourneyStatus;
  run_id?: string;
  cursor?: string;
  total_steps?: number;
  steps_left?: number;
  entries?: JourneyJournalEntry[];
}

/**
 * Per-user progress through a {@link Journey} — and THE object every journey
 * method returns (there is no separate progress DTO). `cursor` is the current
 * step node id; `steps_left` is the badge count. The step DESCRIPTORS are not
 * here: read them from the journey's `graph.json` and derive each step's
 * done/current/upcoming state from `cursor` + `entries`.
 *
 * The backend is the single writer — the frontend only reads this.
 */
@registerEntity
export class JourneyJournal extends APIEntity<JourneyJournal> implements IJourneyJournal {
  static type: string = 'journey_journal';
  journey_id?: string;
  user_id?: string;
  status?: JourneyStatus;
  run_id?: string;
  cursor?: string;
  total_steps?: number;
  steps_left?: number;
  entries?: JourneyJournalEntry[];

  constructor(entity: Partial<IJourneyJournal> = {}) {
    super(entity);
    this.journey_id = entity.journey_id;
    this.user_id = entity.user_id;
    this.status = entity.status;
    this.run_id = entity.run_id;
    this.cursor = entity.cursor;
    this.total_steps = entity.total_steps;
    this.steps_left = entity.steps_left;
    this.entries = entity.entries;
  }

  /** True while this journal is the one being worked on (`new` | `launched`). */
  get isActive(): boolean {
    return this.status === 'new' || this.status === 'launched';
  }
}

export interface IJourney extends IEntity {
  asset_ref?: string;
  enabled?: boolean;
}

/**
 * A guided User Journey — a folder-backed onboarding document. Exposes the
 * journey interface (`launch` / `restart` / `advance` / `progress` / `history`,
 * plus static `resume`); every one resolves to the {@link JourneyJournal} that
 * IS the progress.
 *
 * The `auto_launch` flag lives in the journey's `graph.json` (disk is the
 * single source of truth); the loader asks the backend via `/auto-launch`
 * rather than reading a field here.
 */
@registerEntity
export class Journey extends APIEntity<Journey> implements IJourney {
  static type: string = 'journey';
  asset_ref?: string;
  enabled?: boolean;

  constructor(entity: Partial<IJourney> = {}) {
    super(entity);
    this.asset_ref = entity.asset_ref;
    this.enabled = entity.enabled;
  }

  private get base(): string {
    return `/api/v1/journeys/${this.id}`;
  }

  /** The active journal, else the most recent one, else null (never launched). */
  async progress(): Promise<JourneyJournal | null> {
    const row = await apiClient.get<IJourneyJournal | null>(`${this.base}/progress`);
    return row ? new JourneyJournal(row) : null;
  }

  /** Idempotent — returns the active journal, or starts a fresh one at the entry. */
  async launch(): Promise<JourneyJournal> {
    return new JourneyJournal(await apiClient.post<IJourneyJournal>(`${this.base}/launch`));
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
    return this.assetEditorPointer('journey') ?? super.dockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.assetEditorPointer('journey') ?? super.editorDockPointer;
  }

  override get searchDockPointer(): DockPointerData {
    return this.assetEditorPointer('journey') ?? this.dockPointer;
  }
}
