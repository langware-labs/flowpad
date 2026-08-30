import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import type { AgenticProcess } from '../process/agentic-process';

/**
 * Prompt — a reusable, library-managed prompt (docs/prompt-library.md).
 *
 * Markdown-backed (`<project>/prompts/<name>.md`): frontmatter carries
 * name/icon/color (+ optional group_id folder membership via the generic
 * groups layer); the body is the prompt text. The library UI's single job is
 * `enqueueTo(process)` — everything else is ordinary entity machinery.
 */
export interface IPrompt extends IEntity {
  name: string;
  /** The prompt body (markdown body of the .md file). */
  text?: string | null;
  /** Lucide export name or emoji char — `renderIconValue` resolves either. */
  icon?: string | null;
  /** Hex from the curated contrast-tested palette. */
  color?: string | null;
  project_id?: string | null;
  /** Times this prompt was enqueued from the library. */
  use_count?: number;
  /** ISO timestamp of the last library enqueue. */
  last_used_at?: string | null;
}

// `implements IPrompt` only checks the class; it contributes no members, so every
// field declared solely on IPrompt read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// `icon` is omitted: `APIEntity` owns it as an accessor pair, and an
// optional `icon?:` here is not identical to that required accessor, which
// the merged interface cannot inherit from both sides.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Prompt extends Omit<IPrompt, 'expand' | 'id' | 'is_private' | 'members' | 'icon'> {}

@registerEntity
export class Prompt extends APIEntity<Prompt> implements IPrompt {
  static type: string = 'prompt';

  name: string = '';
  text?: string | null;
  color?: string | null;
  project_id?: string | null;
  use_count: number = 0;
  last_used_at: string | null = null;

  constructor(entity: Partial<IPrompt> = {}) {
    super(entity);
    this.name = entity.name ?? '';
    this.text = entity.text ?? null;
    this.icon = entity.icon ?? null;
    this.color = entity.color ?? null;
    this.project_id = entity.project_id ?? null;
    this.use_count = entity.use_count ?? 0;
    this.last_used_at = entity.last_used_at ?? null;
  }

  static async create(opts: {
    name: string;
    text: string;
    icon?: string | null;
    color?: string | null;
    groupId?: string | null;
    projectId?: string | null;
  }): Promise<Prompt> {
    const prompt = new Prompt({
      name: opts.name,
      text: opts.text,
      icon: opts.icon ?? null,
      color: opts.color ?? null,
      project_id: opts.projectId ?? null,
    });
    prompt.group_id = opts.groupId ?? null;
    // Project-scoped save (POST /graph/project/<id>/prompt): the backend
    // resolves the .md location from the request scope — an unscoped save
    // would land the file under user_home instead of <project>/prompts/.
    const { TypeId } = await import('../models/TypeId');
    return prompt.save(opts.projectId ? new TypeId('project', opts.projectId) : []);
  }

  /**
   * Quick-create parity with the other asset types (`Skill.createInProject` et
   * al.) — an empty-text prompt the user fills in later. `_folderVfsPath` is
   * ignored: TypeInfo.main_subdir fixes the location at `<project>/prompts/`.
   */
  static createInProject(project: { id?: string } | null, name: string, _folderVfsPath?: string): Promise<Prompt> {
    return Prompt.create({ name, text: '', projectId: project?.id ?? null });
  }

  /**
   * prompt → queue: append this prompt's text onto the process's prompt
   * queue (source `library`). The backend owns injection/readiness — see
   * docs/prompt_queue.md. Each enqueue counts as a "use": bump the usage
   * counter + last_used_at and persist (project-scoped, mirroring `create`,
   * so the backing .md stays under `<project>/prompts/`).
   */
  async enqueueTo(process: AgenticProcess): Promise<void> {
    await process.enqueue(this.text ?? '', 'library');
    this.use_count = (this.use_count ?? 0) + 1;
    this.last_used_at = new Date().toISOString();
    const { TypeId } = await import('../models/TypeId');
    await this.save(this.project_id ? new TypeId('project', this.project_id) : []);
  }

  /** All library prompts in a project scope (null → unscoped/user prompts). */
  static async listForProject(projectId: string | null): Promise<Prompt[]> {
    const { dataManager } = await import('../APIEntity');
    const { ExpressionNode, QueryFilter, QueryRequest } = await import('../FlowSync/query');
    const match = projectId
      ? new ExpressionNode({ project_id: projectId })
      : new ExpressionNode({ operands: ['project_id'], op: '$IS_NULL' });
    return dataManager.query<Prompt>(
      new QueryRequest({ type: Prompt.type, query: new QueryFilter({ type: Prompt.type, match }) }),
    );
  }

  /**
   * The most recently used prompt in the project — `last_used_at` first,
   * falling back to `updated_date` so never-used prompts still order.
   */
  static async lastUsedForProject(projectId: string | null): Promise<Prompt | null> {
    const prompts = await Prompt.listForProject(projectId);
    let best: Prompt | null = null;
    let bestTime = -Infinity;
    for (const p of prompts) {
      const stamp = p.last_used_at ?? (p.updated_date ? new Date(p.updated_date).toISOString() : null);
      const t = stamp ? Date.parse(stamp) : NaN;
      if (!Number.isNaN(t) && t > bestTime) {
        bestTime = t;
        best = p;
      }
    }
    return best;
  }
}
