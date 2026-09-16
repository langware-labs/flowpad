import { APIEntity, registerEntity } from '../APIEntity';
import { dataContext } from '../FlowSync/context';
import { FrontMatterFsRef } from '../fs/FrontMatterFsRef';
import { DockPointerData } from '../models/DockPointer';

/**
 * Whiteboard entity — backed by a WhiteboardRecord on disk
 * (~/.claude/whiteboards/<name>/).
 *
 * Folder layout:
 *   <name>/WHITE_BOARD.md  — frontmatter + prose + auto-managed mermaid block
 *   <name>/board.json      — {kind, version, data} Excalidraw payload
 *   <name>/thumbnail.svg   — regenerated on save
 *
 * Create via:  Whiteboard.createInProject(project, name) — calls the same
 * save() path Skill uses, which POSTs the entity and the server materializes
 * the folder.
 */
@registerEntity
export class Whiteboard extends APIEntity<Whiteboard> {
  static type: string = 'whiteboard';
  static override icon = 'Palette';

  description: string = '';
  asset_ref?: string;
  scope?: string;

  constructor(entity: Partial<Whiteboard> = {}) {
    super(entity);
    this.description = entity.description ?? '';
    this.asset_ref = entity.asset_ref;
    this.scope = entity.scope;
  }

  /** Default open target: the asset editor (URL-first navigate target). */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? this.defaultDockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? super.editorDockPointer;
  }


  /** FrontMatterFsRef for WHITE_BOARD.md. Resolves compute node from dataContext. */
  get doc(): FrontMatterFsRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId || !this.asset_ref) return null;
    const mdPath = this.asset_ref.replace(/\/$/, '') + '/WHITE_BOARD.md';
    return new FrontMatterFsRef(mdPath, typeId);
  }

  static async create(name: string, description?: string): Promise<Whiteboard> {
    const wb = new Whiteboard({ name: name.trim(), description: description?.trim() ?? '' });
    return wb.save();
  }

  /** Create in the selected scope, optionally at an exact authorized folder. */
  static async createInProject(
    project: { typeId?: import('../models/TypeId').TypeId } | null,
    name: string,
    destination?: import('../fs/FSRef').FSRefJson,
  ): Promise<Whiteboard> {
    const scopeIds = project?.typeId ? [project.typeId] : [];
    const wb = new Whiteboard({ name: name.trim() });
    return wb.save(scopeIds, destination);
  }
}
