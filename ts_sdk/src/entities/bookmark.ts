import { APIEntity, registerEntity } from '../APIEntity';
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
  }
}
