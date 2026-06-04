import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { DockPointerData } from '../models/DockPointer';
import { ViewType } from '../utils/ui/view-types';

export interface IClaudeSession extends IEntity {
  name?: string;
  message_count?: number;
  slug?: string | null;
}

/**
 * ClaudeTranscript — a Claude CLI session indexed from
 * ``~/.claude/projects/<encoded>/<sessionId>.jsonl``. The entity id IS the
 * Claude session id (see ``flow_sdk/builtin/claude_session.py``). Registered
 * here so shared-transcript chips (``useEntity``) resolve the row's display
 * name instead of failing with "Entity constructor not found".
 */
@registerEntity
export class ClaudeSession extends APIEntity<ClaudeSession> implements IClaudeSession {
  static type: string = 'claude_session';

  name?: string;
  message_count?: number;
  slug?: string | null;

  constructor(entity: Partial<IClaudeSession> = {}) {
    super(entity);
    this.name = entity.name;
    this.message_count = entity.message_count;
    this.slug = entity.slug;
  }

  /** Default open target: the read-only transcript lens (`/dock/lens/claude/transcript/<id>`). */
  override get dockPointer(): DockPointerData {
    return new DockPointerData(ViewType.LENS, `claude/transcript/${this.id}`);
  }
}
