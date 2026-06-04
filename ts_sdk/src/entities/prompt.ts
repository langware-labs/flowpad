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
}

@registerEntity
export class Prompt extends APIEntity<Prompt> implements IPrompt {
  static type: string = 'prompt';

  name: string = '';
  text?: string | null;
  private _icon: string | null = null;

  /** Accessor-pair override + own enumerable mirror — see `Group.icon`. */
  get icon(): string | null {
    return this._icon;
  }

  set icon(v: string | null) {
    this._icon = v ?? null;
  }
  color?: string | null;
  project_id?: string | null;

  constructor(entity: Partial<IPrompt> = {}) {
    super(entity);
    this.name = entity.name ?? '';
    this.text = entity.text ?? null;
    Object.defineProperty(this, 'icon', {
      enumerable: true,
      configurable: true,
      get: () => this._icon,
      set: (v: string | null | undefined) => {
        this._icon = v ?? null;
      },
    });
    this.icon = entity.icon ?? null;
    this.color = entity.color ?? null;
    this.project_id = entity.project_id ?? null;
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
   * prompt → queue: append this prompt's text onto the process's prompt
   * queue (source `library`). The backend owns injection/readiness — see
   * docs/prompt_queue.md.
   */
  async enqueueTo(process: AgenticProcess): Promise<void> {
    await process.enqueue(this.text ?? '', 'library');
  }
}
