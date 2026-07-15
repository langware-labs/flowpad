import { ActionInfo } from '../models';
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export enum BookmarkType {
  NOTE = 'note',
  CONTEXT = 'context',
  SUMMARY = 'summary',
  NOTIFICATION = 'notification',
  NOTIFICATION_FAILED = 'notification_failed',
  TERMINAL_ANNOTATION = 'terminal_annotation',
  FAVORITE = 'favorite',
  FAVORITE_FOLDER = 'favorite_folder',
  PLAN = 'plan',
}

export interface IBookmark extends IEntity {
  bookmark_type?: BookmarkType;
  source?: string;
  title?: string;
  content?: string;
  data?: Record<string, any>;
  session_id?: string;
  work_dir?: string;
  status?: string;
  closed_at?: string;
  remind_at?: string;
  /** Containing FAVORITE_FOLDER bookmark id; '' (or unset) = root. Empty
   *  string, not null — dropped-None serialization + merge-never-removes
   *  would otherwise strand cleared memberships. */
  parent_id?: string;
  /** Manual placement within the parent container. 0/unset = unstamped
   *  (sorts at the END of a stamped container, newest first); stamped values
   *  are contiguous from 1 via the `bookmark.order` action. */
  order?: number;
  /** Times this favorite has been opened. 0/unset = never opened — what the
   *  desktop's unread badges count (see `isUnopened` in use-favorites.ts). */
  counter?: number;
  /** Owning project id, stamped at favorite-creation time from the current
   *  project context. Carried as a plain field (the record still saves under
   *  the unscoped @local desktop so webhook-created favorites stay visible);
   *  the bookmarks slider filters favorites by this against the scope filter. */
  project_id?: string | null;
}

@registerEntity
export class Bookmark extends APIEntity<Bookmark> implements IBookmark {
  bookmark_type?: BookmarkType;
  source?: string;
  title?: string;
  content?: string;
  data?: Record<string, any>;
  session_id?: string;
  work_dir?: string;
  status?: string;
  closed_at?: string;
  remind_at?: string;
  parent_id?: string;
  order?: number;
  counter?: number;
  project_id?: string | null;
  static type: string = 'bookmark';

  constructor(entity: Partial<IBookmark> = {}) {
    super(entity);
    this.bookmark_type = entity.bookmark_type;
    this.source = entity.source;
    this.title = entity.title;
    this.content = entity.content;
    this.data = entity.data ||= {};
    this.session_id = entity.session_id;
    this.work_dir = entity.work_dir;
    this.status = entity.status;
    this.closed_at = entity.closed_at;
    this.remind_at = entity.remind_at;
    this.parent_id = entity.parent_id;
    this.order = entity.order;
    this.counter = entity.counter;
    this.project_id = entity.project_id ?? null;
  }

  /** Desktop drag-drop commit — splice a bookmark into the drop gap within
   *  its container (root '' or a folder id). Mirrors Tab.reorder; the server
   *  registers the handler type-qualified as `bookmark.order`. */
  static async reorder(
    reorderId: string,
    afterId: string | null,
    beforeId: string | null,
    parentId: string = '',
  ): Promise<void> {
    const info = new ActionInfo('order', Bookmark.type, null, 'POST');
    info.bodyParameters = {
      reorder_bookmark_id: reorderId,
      after_bookmark_id: afterId,
      before_bookmark_id: beforeId,
      parent_id: parentId,
    };
    await dataManager.callAction<unknown, { bookmarks: IBookmark[] }>(info);
  }
}
