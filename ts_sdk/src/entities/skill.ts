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

  name: string = '';
  description: string = '';
  source_path?: string;
  scope?: string;

  constructor(entity: Partial<Skill> = {}) {
    super(entity);
    this.name = entity.name ?? '';
    this.description = entity.description ?? '';
    this.source_path = entity.source_path;
    this.scope = entity.scope;
  }

  get displayName(): string {
    return this.name || 'Untitled Skill';
  }

  override get editorDockPointer(): DockPointerData {
    const path = this.source_path ?? this.id;
    return new DockPointerData(ViewType.ASSETS, `editor/skill/${path}`);
  }

  override get searchDockPointer(): DockPointerData {
    if (this.source_path) {
      return new DockPointerData(ViewType.ASSETS, `editor/skill/${this.source_path.replace(/^\//, '')}`);
    }
    return this.dockPointer;
  }

  /** FrontMatterFsRef for SKILL.md. Resolves compute node from dataContext. */
  get doc(): FrontMatterFsRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId || !this.source_path) return null;
    const mdPath = this.source_path.replace(/\/$/, '') + '/SKILL.md';
    return new FrontMatterFsRef(mdPath, typeId);
  }

  static async create(name: string, description?: string): Promise<Skill> {
    const skill = new Skill({ name: name.trim(), description: description?.trim() ?? '' });
    return skill.save();
  }
}
