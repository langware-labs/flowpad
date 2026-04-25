import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IMarkdown extends IEntity {
  name?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
  title?: string;
  tags?: string[];
  links?: string[];
  scope?: string;
}

/**
 * Markdown (Docs) entity — wiki/markdown files under `.claude/docs/*.md`.
 *
 * Creation goes through ``new Markdown().save(scope)`` only. The backend
 * Entity.save() resolves scope from request_context, calls
 * ``MarkdownRecord.upsert_main_ref(self)`` which writes the .md file iff it
 * doesn't yet exist, and returns the entity with ``asset_ref`` populated.
 * No fsManager.writeFile shortcut, no indexer-lag race.
 */
@registerEntity
export class Markdown extends APIEntity<Markdown> implements IMarkdown {
  static type: string = 'markdown';

  name?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
  title?: string;
  tags?: string[];
  links?: string[];
  scope?: string;

  constructor(entity: Partial<IMarkdown> = {}) {
    super(entity);
    this.name = entity.name;
    this.asset_ref = entity.asset_ref;
    this.asset_type = entity.asset_type;
    this.parent_path = entity.parent_path;
    this.vault_root = entity.vault_root;
    this.title = entity.title;
    this.tags = entity.tags;
    this.links = entity.links;
    this.scope = entity.scope;
  }

  /**
   * Create a markdown doc scoped to the given project. Mirrors
   * ``Skill.createInProject`` / ``Agent.createInProject`` — the file is
   * written by the backend's ``MarkdownRecord.upsert_main_ref`` inside
   * ``Entity.save()``, so the resulting entity is in the cache immediately.
   */
  static async createInProject(
    project: { typeId?: import('../models/TypeId').TypeId } | null,
    name: string,
  ): Promise<Markdown> {
    const scopeIds = project?.typeId ? [project.typeId] : [];
    const md = new Markdown({ name: name.trim() });
    return md.save(scopeIds);
  }
}
