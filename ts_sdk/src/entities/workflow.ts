import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { DockPointerData } from '../models/DockPointer';
import { ActionInfo } from '../models/ActionInfo';
import { TypeId } from '../models/TypeId';
import { fsManager } from '../services/fsService';
import { ViewType } from '../utils/ui/view-types';

/**
 * Workflow entity - Represents an agentic workflow execution.
 *
 * Workflows are AMD (Agentic Markdown) documents that define automated tasks.
 * Each workflow is stored as a main.md file in the project's workflows directory.
 *
 * Path structure: <project>/workflows/<workflow_id>/main.md
 */
@registerEntity
export class Workflow extends APIEntity<Workflow> {
  static type: string = 'workflow';

  /** Display name of the workflow */
  name?: string;

  /** Description of the workflow */
  description?: string;

  /** VFS path to the workflow file (e.g., workflows/<uuid>/main.md) */
  source_vfs_path?: string;

  /** ID of the parent project */
  project_id?: string;

  /** Tab index for UI display (null = not in tabs, 0+ = tab position) */
  tab_index?: number | null;

  /** VFS path to the prepared file (e.g., workflows/name.prepared.md) */
  prepared_vfs_path?: string;

  /** VFS path to the generated pipeline.json */
  pipeline_vfs_path?: string;

  constructor(entity: Partial<Workflow> = {}) {
    super(entity);
    this.name = entity.name;
    this.description = entity.description;
    this.source_vfs_path = entity.source_vfs_path;
    this.project_id = entity.project_id;
    this.tab_index = entity.tab_index ?? null;
    this.prepared_vfs_path = entity.prepared_vfs_path;
    this.pipeline_vfs_path = entity.pipeline_vfs_path;
  }

  // ── Prepared-file helpers ────────────────────────────────────────────────

  /** Derive the prepared file path from a source path. */
  static derivePreparedPath(sourcePath: string): string {
    return sourcePath.replace(/\.md$/, '.prepared.md');
  }

  /** True when a prepared file path is recorded on this entity. */
  get isPrepared(): boolean {
    return !!this.prepared_vfs_path;
  }

  /** The prepared VFS path, or null if not yet prepared. */
  get preparedPath(): string | null {
    return this.prepared_vfs_path ?? null;
  }

  // ── Pipeline helpers ──────────────────────────────────────────────────────

  /** Derive the pipeline.json path from a source path. */
  static derivePipelinePath(sourcePath: string): string {
    return sourcePath.replace(/\.md$/, '.pipeline.json');
  }

  /** True when a pipeline JSON path is recorded on this entity. */
  get hasPipeline(): boolean {
    return !!this.pipeline_vfs_path;
  }

  /** The pipeline VFS path, or null if not yet generated. */
  get pipelinePath(): string | null {
    return this.pipeline_vfs_path ?? null;
  }

  /**
   * Call the backend prepare action: parse the AMD markdown into a Pipeline
   * JSON, write it to VFS, and update pipeline_vfs_path on this entity.
   */
  async prepare(): Promise<{ pipeline_vfs_path: string }> {
    const actionInfo = new ActionInfo('prepare', Workflow.type, this.id, 'POST');
    const result = await dataManager.callAction<null, { pipeline_vfs_path: string }>(actionInfo);
    // Sync the new path back onto the local instance
    if (result?.pipeline_vfs_path) {
      this.pipeline_vfs_path = result.pipeline_vfs_path;
    }
    return result as { pipeline_vfs_path: string };
  }

  /**
   * Verify the prepared file actually exists on disk.
   * If it does not, clears `prepared_vfs_path` and persists the entity.
   * Returns true when the file is confirmed present.
   */
  async verifyPrepared(fsTypeId: TypeId): Promise<boolean> {
    if (!this.prepared_vfs_path) return false;
    const exists = await fsManager.exists(fsTypeId, this.prepared_vfs_path);
    if (!exists) {
      this.prepared_vfs_path = undefined;
      await this.save();
    }
    return exists;
  }

  /**
   * Get the display name for the workflow
   */
  get displayName(): string {
    return this.name || 'Untitled Workflow';
  }

  override get dockPointer(): DockPointerData {
    return new DockPointerData(ViewType.WORKFLOWS, this.id);
  }

  /**
   * Create a new workflow: saves the entity, writes the initial .md file,
   * and links source_vfs_path — no dataContext required.
   */
  static async create(name: string): Promise<Workflow> {
    const { ComputeNode } = await import('./compute-node/compute-node');
    const { Project } = await import('./project');

    const computeNode = await ComputeNode.getById('@local');
    if (!computeNode) throw new Error('No local compute node');
    const project = await dataManager.getByTypeId<Project>(new TypeId(Project.type, '@local'));

    const mountPath = project?.fs_storage_mount_path ?? '';
    const vfsBase = mountPath.startsWith('/') ? mountPath.slice(1) : mountPath;
    const safeName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const vfsPath = vfsBase ? `${vfsBase}/workflows/${safeName}.md` : `workflows/${safeName}.md`;

    const workflow = new Workflow({ name: name.trim() });
    const saved = await workflow.save();

    await fsManager.writeFile(computeNode.typeId, vfsPath, `# ${name.trim()}\n`);

    saved.source_vfs_path = vfsPath;
    await saved.save();

    return saved;
  }

  /**
   * Rename this workflow: renames the linked file and updates name + source_vfs_path.
   */
  async rename(newName: string): Promise<void> {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === this.name) return;

    const { ComputeNode } = await import('./compute-node/compute-node');
    const computeNode = await ComputeNode.getById('@local');
    if (!computeNode) throw new Error('No local compute node');

    if (this.source_vfs_path) {
      const safeName = trimmed.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      await fsManager.rename(computeNode.typeId, this.source_vfs_path, `${safeName}.md`);
      const dir = this.source_vfs_path.replace(/\/[^/]+$/, '');
      this.source_vfs_path = `${dir}/${safeName}.md`;
    }

    this.name = trimmed;
    await this.save();
  }

  /**
   * Start an agentic process for this workflow and return the process + shellId.
   * Mirrors the doRun logic in WorkflowEditor.
   */
  async run(): Promise<{ process: import('../agentic_processor/agentic-process').AgenticProcess; shellId: string }> {
    const { dataContext } = await import('../FlowSync/context');

    const computeNode = dataContext.computeNode;
    if (!computeNode) throw new Error('[Workflow.run] No local compute node');
    const processor = await computeNode.createAgenticProcessor();
    const process = await processor.createProcess({ permissionMode: 'bypassPermissions' });

    const systemSkills = dataContext.bootstrapInfo?.desktop_info?.paths?.system_skills;
    const flowSkillPath = systemSkills
      ? `/${systemSkills}/flow/SKILL.md`
      : '~/.flow/system_assets/skills/flow/SKILL.md';
    const instruction = `Run workflow at /${this.source_vfs_path} using the flow skill located at: ${flowSkillPath}`;

    const { shellId } = await process.start({ instruction });
    return { process, shellId };
  }

  /**
   * Override toJSON to ensure tab_index is always serialized
   */
  toJSON(): any {
    const json = super.toJSON();
    // Explicitly include tab_index, even if null (to ensure it's sent to backend)
    json.tab_index = this.tab_index;
    return json;
  }
}
