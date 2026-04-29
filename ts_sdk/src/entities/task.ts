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
  /** Local Project FK — receiver picks via the mapping dialog; sender's own project at send time. */
  project_id?: string | null;
  /** Cached `Spec.spec_type` so receivers don't need the Spec loaded to know "session" vs "plan". */
  spec_type?: string | null;
  /** Local AgenticProcess for this conversation (the user's clean Claude Code session). */
  my_process_id?: string | null;
  /** Forked AgenticProcess that runs *approved* incoming prompts. Initiator-only. */
  shared_process_id?: string | null;
  /** Cross-machine identity of the *sender's* project. Used as the key in the per-machine mapping table. */
  remote_project_id?: string | null;
  /** Display name of the sender's project (for the mapping dialog copy). */
  remote_project_name?: string | null;
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
  project_id?: string | null;
  spec_type?: string | null;
  my_process_id?: string | null;
  shared_process_id?: string | null;
  remote_project_id?: string | null;
  remote_project_name?: string | null;
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
    this.project_id = entity.project_id;
    this.spec_type = entity.spec_type;
    this.my_process_id = entity.my_process_id;
    this.shared_process_id = entity.shared_process_id;
    this.remote_project_id = entity.remote_project_id;
    this.remote_project_name = entity.remote_project_name;
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
      const root = JSON.parse(this.description).root;
      const lines: string[] = (root.children || []).map((paragraph: any) =>
        (paragraph.children || []).map((node: any) => node.text || '').join('')
      );
      return lines.join('\n');
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

  /**
   * Create a task with the given title. The `project` argument is accepted for
   * API parity with other createInProject statics (tasks aren't file-backed per project today).
   */
  static async createInProject(
    _project: unknown,
    name: string,
    _folderVfsPath?: string,
  ): Promise<Task> {
    const task = new Task({ title: name.trim() });
    return task.save();
  }
}
