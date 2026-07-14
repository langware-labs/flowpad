import { APIEntity, registerEntity } from '../APIEntity';
import { dataContext } from '../FlowSync/context';
import { FrontMatterFsRef } from '../fs/FrontMatterFsRef';
import { DockPointerData } from '../models/DockPointer';
import { TypeId } from '../models/TypeId';
import { IEntity } from '../IEntity';
import type { GitOrigin } from '../models/GitOrigin';

export enum TaskKind {
  STANDARD = 'standard',
  GROUP = 'group',
}

export interface ITask extends IEntity {
  title?: string;
  /** Folder-backed asset: tasks/<name>/ holding task.md + inner spec.md. */
  asset_ref?: string;
  description?: string;
  status?: string;
  /** TaskKind: 'group' = overview task owning one member task per group member. */
  kind?: string;
  /** Group-task parent pointer; '' = top-level. Children own only their status. */
  parent_id?: string;
  /** The member's deliverable (repo / PR / doc / app URL); rides hub reflection. */
  submission_url?: string | null;
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
  shared_by_id?: string | null;
  /** Local Project FK — receiver picks via the mapping dialog; sender's own project at send time. */
  project_id?: string | null;
  /** Cached `Spec.spec_type` so receivers don't need the Spec loaded to know "session" vs "plan". */
  spec_type?: string | null;
  /** Local AgenticProcess for this conversation (the user's clean Claude Code session). */
  my_process_id?: string | null;
  /** Forked AgenticProcess that runs *approved* incoming prompts. Initiator-only. */
  shared_process_id?: string | null;

  // Promoted from former `metadata` blob — first-class fields.
  active_form?: string | null;
  analysis_json_path?: string | null;
  analysis_path?: string | null;
  artifacts?: any[] | null;
  classification_category?: string | null;
  classification_command?: string | null;
  classification_path?: string | null;
  classification_title?: string | null;
  command?: string | null;
  completed_at?: Date | string | null;
  error_fingerprint?: string | null;
  folder_name?: string | null;
  output_dir?: string | null;
  process_id?: string | null;
  project_name?: string | null;
  project_root?: string | null;
  git_origin?: GitOrigin | null;
  recipient_email?: string | null;
  result_uname?: string | null;
  sender_email?: string | null;
  sender_name?: string | null;
  session_id?: string | null;
  skill_name?: string | null;
  skill_path?: string | null;
  skill_scope?: string | null;
  task_type_label?: string | null;
  team_space_id?: string | null;
  worker_session_id?: string | null;
}

@registerEntity
export class Task extends APIEntity<Task> implements ITask {
  title: string;
  asset_ref?: string;
  description?: string;
  status?: string;
  kind?: string;
  parent_id?: string;
  submission_url?: string | null;
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
  shared_by_id?: string | null;
  project_id?: string | null;
  spec_type?: string | null;
  my_process_id?: string | null;
  shared_process_id?: string | null;

  active_form?: string | null;
  analysis_json_path?: string | null;
  analysis_path?: string | null;
  artifacts?: any[] | null;
  classification_category?: string | null;
  classification_command?: string | null;
  classification_path?: string | null;
  classification_title?: string | null;
  command?: string | null;
  completed_at?: Date | string | null;
  error_fingerprint?: string | null;
  folder_name?: string | null;
  output_dir?: string | null;
  process_id?: string | null;
  project_name?: string | null;
  project_root?: string | null;
  git_origin?: GitOrigin | null;
  recipient_email?: string | null;
  result_uname?: string | null;
  sender_email?: string | null;
  sender_name?: string | null;
  session_id?: string | null;
  skill_name?: string | null;
  skill_path?: string | null;
  skill_scope?: string | null;
  task_type_label?: string | null;
  team_space_id?: string | null;
  worker_session_id?: string | null;

  static type: string = 'task';

  constructor(entity: Partial<ITask> = {}) {
    super(entity);
    this.title = entity.title ||= '';
    this.asset_ref = entity.asset_ref;
    this.description = entity.description;
    this.status = entity.status;
    this.kind = entity.kind;
    this.parent_id = entity.parent_id;
    this.submission_url = entity.submission_url;
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
    this.shared_by_id = entity.shared_by_id;
    this.project_id = entity.project_id;
    this.spec_type = entity.spec_type;
    this.my_process_id = entity.my_process_id;
    this.shared_process_id = entity.shared_process_id;

    this.active_form = entity.active_form;
    this.analysis_json_path = entity.analysis_json_path;
    this.analysis_path = entity.analysis_path;
    this.artifacts = entity.artifacts;
    this.classification_category = entity.classification_category;
    this.classification_command = entity.classification_command;
    this.classification_path = entity.classification_path;
    this.classification_title = entity.classification_title;
    this.command = entity.command;
    this.completed_at = entity.completed_at;
    this.error_fingerprint = entity.error_fingerprint;
    this.folder_name = entity.folder_name;
    this.output_dir = entity.output_dir;
    this.process_id = entity.process_id;
    this.project_name = entity.project_name;
    this.project_root = entity.project_root;
    this.git_origin = entity.git_origin;
    this.recipient_email = entity.recipient_email;
    this.result_uname = entity.result_uname;
    this.sender_email = entity.sender_email;
    this.sender_name = entity.sender_name;
    this.session_id = entity.session_id;
    this.skill_name = entity.skill_name;
    this.skill_path = entity.skill_path;
    this.skill_scope = entity.skill_scope;
    this.task_type_label = entity.task_type_label;
    this.team_space_id = entity.team_space_id;
    this.worker_session_id = entity.worker_session_id;
  }

  /** Default open target: the generic task asset editor (URL-first). */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer('task') ?? super.dockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.assetEditorPointer('task') ?? super.editorDockPointer;
  }

  override get searchDockPointer(): DockPointerData {
    return this.assetEditorPointer('task') ?? this.dockPointer;
  }

  /** FrontMatterFsRef for task.md (frontmatter fields + description body). */
  get doc(): FrontMatterFsRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId || !this.asset_ref) return null;
    return new FrontMatterFsRef(this.asset_ref.replace(/\/$/, '') + '/task.md', typeId);
  }

  /** FrontMatterFsRef for the inner spec.md (the plan/issue — a plain file). */
  get specDoc(): FrontMatterFsRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId || !this.asset_ref) return null;
    return new FrontMatterFsRef(this.asset_ref.replace(/\/$/, '') + '/spec.md', typeId);
  }

  // NOTE: Task's former FE-side projection of project_id / assignee /
  // my_process_id / shared_process_id into the chip context lived here as
  // ``_directFieldsAsTypeIds``. Implicit projection moved server-side
  // (Python ``Entity.get_implicit_private_context_entities``): the backend
  // computes the merged ``private_context_entities`` list and ships it
  // over the wire. The FE never combines implicit + explicit any more.
  // Currently only ``project_id`` is implicit; assignee / my_process_id /
  // shared_process_id were dropped per "base returns project_id only for
  // now" — reintroduce in Python's ``get_implicit_private_context_entities``
  // override on Task if there's a confirmed UX need.

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
