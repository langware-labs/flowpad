import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { DockPointerData } from '../models/DockPointer';
import type { FSRefJson } from '../fs/FSRef';

/**
 * One translated copy of a markdown asset's primary doc. Mirrors the backend
 * `Translation` model (flow_sdk/builtin/claude_memory_entities.py).
 *
 * A translation is NOT a separate entity — it is an alternate body file of the
 * same asset (`translations/<lang>.md` under the record-data folder), selected
 * inline by the `?lang=<code>` dock prop. `ref` is carried so the UI reads the
 * file directly instead of computing a records_data path; `process_id` is the
 * launching translator worker, from which "translating" vs "ready" is derived.
 */
export interface Translation {
  lang: string;
  ref: FSRefJson;
  process_id?: string | null;
}

export interface IMarkdown extends IEntity {
  name?: string;
  asset_ref?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
  title?: string;
  tags?: string[];
  links?: string[];
  translations?: Translation[];
  scope?: string;
  project_id?: string;
}

/**
 * Markdown (Docs) entity — wiki/markdown files under `docs/*.md` (AssetClass.DOCS).
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
  translations?: Translation[];
  scope?: string;
  project_id?: string;

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
    this.translations = entity.translations ?? [];
    this.scope = entity.scope;
    this.project_id = entity.project_id;
  }

  /**
   * Default open target: the markdown asset editor. Drives URL-first
   * navigation (e.g. `flow navigate entity markdown-<id>`); without this the
   * base `APIEntity.dockPointer` (HOME) would send the doc to the home view.
   */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer('markdown') ?? super.dockPointer;
  }

  /**
   * Create a markdown doc scoped to the given project. Mirrors
   * ``Skill.createInProject`` / ``SubAgent.createInProject`` — the file is
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
