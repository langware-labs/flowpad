import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { DockPointerData } from '../models/DockPointer';
import { ViewType } from '../utils/ui/view-types';

export interface IWorkerSession extends IEntity {
  name?: string;
  message_count?: number;
  slug?: string | null;
  /** Working directory the session ran in — the cwd fallback for project resolution. */
  cwd?: string | null;
  /** Owning project, resolved from `cwd` by the indexer (the primary source). */
  project_id?: string | null;
  /** The transcript file itself. A session IS this file, so it is a file-backed
   *  asset: locally-run sessions point at the worker's own CLI dir, received
   *  ones at wherever the user installed them. */
  asset_ref?: string | null;
  /** True when this session arrived via a shared message and never ran here —
   *  so it is not resumable. */
  received?: boolean;
}

/**
 * Session entity type → worker key (`claude_session` → `claude`).
 *
 * The ONE place this direction is derived on the frontend. Deriving it beats
 * listing the types: a new worker gets its transcript opening for free, and no
 * call site can hardcode a single worker (which is exactly how claude ended up
 * on a different open path from codex/copilot).
 */
export function workerFromSessionType(type: string | undefined): string {
  return String(type ?? '').replace(/_session$/, '');
}

/**
 * Shared base for the worker-session entities (claude / codex / copilot).
 *
 * Default open target is the read-only transcript lens. Two ref forms, both
 * already understood by `LensViewer`:
 *
 *   - `asset_ref` present → `<worker>/transcript/<absolutePath>`. This is the
 *     form a RECEIVED transcript uses: it is an ordinary installed asset living
 *     wherever the user chose, so it is addressed by path.
 *   - otherwise → `<worker>/transcript/<sessionId>`, resolved server-side
 *     against this machine's CLI dir. Locally-run sessions keep this.
 *
 * The worker is derived from the entity type, never written literally.
 */
export abstract class WorkerSession<T extends APIEntity<T>>
  extends APIEntity<T>
  implements IWorkerSession
{
  name?: string;
  message_count?: number;
  slug?: string | null;
  cwd?: string | null;
  project_id?: string | null;
  asset_ref?: string | null;
  received?: boolean;

  constructor(entity: Partial<IWorkerSession> = {}) {
    super(entity);
    this.name = entity.name;
    this.message_count = entity.message_count;
    this.slug = entity.slug;
    this.cwd = entity.cwd;
    this.project_id = entity.project_id;
    this.asset_ref = entity.asset_ref;
    this.received = entity.received;
  }

  override get dockPointer(): DockPointerData {
    const worker = workerFromSessionType(this.type);
    const ref = (this.asset_ref ?? '').trim();
    const target = encodeURIComponent(ref || this.id);
    return new DockPointerData(ViewType.LENS, `${worker}/transcript/${target}`);
  }
}

/**
 * ClaudeTranscript — a Claude CLI session, indexed from
 * ``~/.claude/projects/<encoded>/<sessionId>.jsonl``. The entity id IS the
 * Claude session id (see ``flow_sdk/builtin/claude_session.py``). Registered so
 * shared-transcript chips (``useEntity``) resolve the row's display name
 * instead of failing with "Entity constructor not found".
 */
@registerEntity
export class ClaudeSession extends WorkerSession<ClaudeSession> {
  static type: string = 'claude_session';
}

/** Codex CLI session — rollout JSONL under ``~/.codex/sessions/``. */
@registerEntity
export class CodexSession extends WorkerSession<CodexSession> {
  static type: string = 'codex_session';
}

/** Copilot CLI session — events JSONL under ``~/.copilot/session-state/``. */
@registerEntity
export class CopilotSession extends WorkerSession<CopilotSession> {
  static type: string = 'copilot_session';
}
