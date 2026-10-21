import { APIEntity, registerEntity } from '../APIEntity';
import { dataContext } from '../FlowSync/context';
import { FrontMatterFsRef } from '../fs/FrontMatterFsRef';
import { DockPointerData } from '../models/DockPointer';

/** How a chart is drawn — and which file in its folder is the source. Mirrors Python's `ChartFormat`. */
export const CHART_FORMATS = ['sequence', 'excalidraw', 'mermaid'] as const;

export type ChartFormat = (typeof CHART_FORMATS)[number];

/** A row without a known `format` is a board. */
export function chartFormatOf(value: unknown): ChartFormat {
  return CHART_FORMATS.includes(value as ChartFormat) ? (value as ChartFormat) : 'excalidraw';
}

/**
 * Chart entity — backed by a ChartRecord on disk (`<scope>/agentic-assets/chart/<name>/`).
 *
 * Folder layout:
 *   <name>/CHART.md       — frontmatter {id, name, description, format, session?} + prose + auto-managed mermaid block
 *   <name>/chart.json     — format `sequence`: a chartit.sequence value {participants, messages}
 *   <name>/board.json     — format `excalidraw`: {kind, version, data} Excalidraw payload
 *   <name>/thumbnail.svg  — regenerated on save
 * Format `mermaid` keeps its source in CHART.md's mermaid block.
 *
 * Create via:  Chart.createInProject(project, name, format) — the same save()
 * path Skill uses, which POSTs the entity and the server materializes the folder.
 */
@registerEntity
export class Chart extends APIEntity<Chart> {
  static type: string = 'chart';

  description: string = '';
  format: ChartFormat = 'excalidraw';
  /** The agentic process (its id) that builds this chart — feedback is submitted to it. */
  session?: string;
  asset_ref?: string;
  scope?: string;

  constructor(entity: Partial<Chart> = {}) {
    super(entity);
    this.description = entity.description ?? '';
    this.format = chartFormatOf(entity.format);
    this.session = entity.session;
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

  /** FrontMatterFsRef for CHART.md. Resolves compute node from dataContext. */
  get doc(): FrontMatterFsRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId || !this.asset_ref) return null;
    const mdPath = this.asset_ref.replace(/\/$/, '') + '/CHART.md';
    return new FrontMatterFsRef(mdPath, typeId);
  }

  static async create(name: string, format: ChartFormat = 'excalidraw'): Promise<Chart> {
    return Chart.createInProject(null, name, format);
  }

  /** Create in the selected scope, optionally at an exact authorized folder. */
  static async createInProject(
    project: { typeId?: import('../models/TypeId').TypeId } | null,
    name: string,
    format: ChartFormat = 'excalidraw',
    destination?: import('../fs/FSRef').FSRefJson,
  ): Promise<Chart> {
    const scopeIds = project?.typeId ? [project.typeId] : [];
    const chart = new Chart({ name: name.trim(), format });
    return chart.save(scopeIds, destination);
  }
}
