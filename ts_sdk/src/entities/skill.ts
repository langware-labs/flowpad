import { APIEntity, registerEntity } from '../APIEntity';
import { dataContext } from '../FlowSync/context';
import { FrontMatterFsRef } from '../fs/FrontMatterFsRef';
import { DockPointerData } from '../models/DockPointer';
import { ViewType } from '../utils/ui/view-types';

/**
 * Skill entity — backed by a SkillRecord on disk (~/.claude/skills/<name>/).
 *
 * Create via:  const skill = new Skill({ name: 'my-skill' }); await skill.save();
 * This calls POST /api/v1/graph/skill which creates the skill folder + SKILL.md server-side.
 */
@registerEntity
export class Skill extends APIEntity<Skill> {
  static type: string = 'skill';
  static override icon = 'Sparkles';

  description: string = '';
  asset_ref?: string;
  scope?: string;
  /** Raw SKILL.md frontmatter (the indexer slurps every yaml key in here). */
  metadata?: Record<string, unknown>;

  constructor(entity: Partial<Skill> = {}) {
    super(entity);
    this.description = entity.description ?? '';
    this.asset_ref = entity.asset_ref;
    this.scope = entity.scope;
    this.metadata = entity.metadata;
  }

  /**
   * Whether the skill is flagged for usage evaluation (`eval: true` frontmatter).
   * `serializeFrontmatter` quotes values, so this round-trips as the string
   * `'true'`/`'false'` — compare as a string, never expect a yaml boolean.
   */
  get isEval(): boolean {
    return String(this.metadata?.eval) === 'true';
  }

  /** Default open target: the asset editor (URL-first navigate target). */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer('skill') ?? super.dockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.assetEditorPointer('skill') ?? super.editorDockPointer;
  }

  override get searchDockPointer(): DockPointerData {
    return this.assetEditorPointer('skill') ?? this.dockPointer;
  }

  /** FrontMatterFsRef for SKILL.md. Resolves compute node from dataContext. */
  get doc(): FrontMatterFsRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId || !this.asset_ref) return null;
    const mdPath = this.asset_ref.replace(/\/$/, '') + '/SKILL.md';
    return new FrontMatterFsRef(mdPath, typeId);
  }

  static async create(name: string, description?: string): Promise<Skill> {
    const skill = new Skill({ name: name.trim(), description: description?.trim() ?? '' });
    return skill.save();
  }

  /**
   * Create a skill scoped to the given project. If `project` is null, creates in the user's
   * home (~/.claude/skills/<name>/). `folderVfsPath` is reserved for future fine-grained
   * placement; the server derives the path from project scope today.
   */
  static async createInProject(
    project: { typeId?: import('../models/TypeId').TypeId } | null,
    name: string,
    _folderVfsPath?: string,
  ): Promise<Skill> {
    const scopeIds = project?.typeId ? [project.typeId] : [];
    const skill = new Skill({ name: name.trim() });
    return skill.save(scopeIds);
  }
}
