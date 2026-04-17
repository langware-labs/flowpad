import { APIEntity, registerEntity } from '../APIEntity';
import { DockPointerData } from '../models/DockPointer';
import { ViewType } from '../utils/ui/view-types';
import { IEntity } from '../IEntity';

export interface ITask extends IEntity {
  title?: string;
  description?: string;
  status?: string;
  last_viewed_at?: Date;
  due_at?: Date;
  start_date?: string | null;
  ttl?: number | null;
  target_entity?: string | null;
  archived_at?: string | null;
  assignee?: string;
  reporter?: string;
  workspace_id?: string;
  task_type?: string;
  priority?: string;
  tags?: string[];
  links?: Record<string, string>;
  metadata?: Record<string, any>;
  spec_id?: string | null;
  shared_by_id?: string | null;
  conversation_id?: string | null;
}

@registerEntity
export class Task extends APIEntity<Task> implements ITask {
  title: string;
  description?: string;
  status?: string;
  last_viewed_at?: Date;
  due_at?: Date;
  start_date?: string | null;
  ttl?: number | null;
  target_entity?: string | null;
  archived_at?: string | null;
  assignee?: string;
  reporter?: string;
  workspace_id?: string;
  task_type?: string;
  priority?: string;
  tags?: string[];
  links?: Record<string, string>;
  metadata?: Record<string, any>;
  spec_id?: string | null;
  shared_by_id?: string | null;
  conversation_id?: string | null;
  static type: string = 'task';

  constructor(entity: Partial<ITask> = {}) {
    super(entity);
    this.title = entity.title ||= '';
    this.description = entity.description;
    this.status = entity.status;
    this.last_viewed_at = entity.last_viewed_at;
    this.due_at = entity.due_at;
    this.start_date = entity.start_date;
    this.ttl = entity.ttl;
    this.target_entity = entity.target_entity;
    this.archived_at = entity.archived_at;
    this.assignee = entity.assignee;
    this.reporter = entity.reporter;
    this.workspace_id = entity.workspace_id;
    this.task_type = entity.task_type;
    this.priority = entity.priority;
    this.tags = entity.tags ||= [];
    this.links = entity.links ||= {};
    this.metadata = entity.metadata ||= {};
    this.spec_id = entity.spec_id;
    this.shared_by_id = entity.shared_by_id;
    this.conversation_id = entity.conversation_id;
  }

  override get searchDockPointer(): DockPointerData {
    return new DockPointerData(ViewType.TASKS, this.id);
  }

  // TODO: Remove getter and setter for descriptionPlainText when task is created with lexical description
  get descriptionPlainText(): string {
    if (!this.description || this.description === '') {
      return '';
    }
    try {
      return JSON.parse(this.description).root.children[0].children[0]?.text || '';
    } catch (e) {
      console.error('Error parsing task description', e, this.description);
      return this.description;
    }
  }

  set descriptionPlainText(text: string) {
    this.description = text
      ? JSON.stringify({
          root: {
            children: [
              {
                children: [
                  {
                    text,
                    type: 'text',
                    version: 1,
                  },
                ],
                type: 'paragraph',
                version: 1,
              },
            ],
            type: 'root',
            version: 1,
          },
        })
      : '';
  }

}
