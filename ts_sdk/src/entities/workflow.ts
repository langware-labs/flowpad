import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { DockPointerData } from '../models/DockPointer';
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

  constructor(entity: Partial<Workflow> = {}) {
    super(entity);
    this.name = entity.name;
    this.description = entity.description;
    this.source_vfs_path = entity.source_vfs_path;
    this.project_id = entity.project_id;
    this.tab_index = entity.tab_index ?? null;
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
   * Create a new workflow in the given project. Writes the initial .md file
   * first and then persists the entity with `source_vfs_path` set — atomic,
   * so a failed file write never leaves an orphan entity behind. Falls back
   * to `@local` project when `project` is null.
   */
  static async createInProject(
    project: { fs_storage_mount_path?: string } | null,
    name: string,
    folderVfsPath?: string,
  ): Promise<Workflow> {
    const { ComputeNode } = await import('./compute-node/compute-node');
    const { Project } = await import('./project');

    const computeNode = await ComputeNode.getById('@local');
    if (!computeNode) throw new Error('No local compute node');

    let resolvedProject = project;
    if (!resolvedProject) {
      resolvedProject = await dataManager.getByTypeId<Project>(new TypeId(Project.type, '@local'));
    }

    const mountPath = resolvedProject?.fs_storage_mount_path ?? '';
    const vfsBase = mountPath.startsWith('/') ? mountPath.slice(1) : mountPath;
    const folder = folderVfsPath ?? 'workflows';
    const safeName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const vfsPath = vfsBase ? `${vfsBase}/${folder}/${safeName}.md` : `${folder}/${safeName}.md`;

    // Atomic create: write the file first, then persist the entity with its
    // source_vfs_path already set. If the file write fails, no orphan entity
    // is left behind (Record rule R10 — the file is the source of truth).
    await fsManager.writeFile(computeNode.typeId, vfsPath, `# ${name.trim()}\n`);
    const workflow = new Workflow({ name: name.trim(), source_vfs_path: vfsPath });
    return workflow.save();
  }

  /** Backward-compat alias: create a workflow in the default (@local) project. */
  static async create(name: string): Promise<Workflow> {
    return Workflow.createInProject(null, name);
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
  async run(): Promise<{ process: import('../process/agentic-process').AgenticProcess; shell: import('./shell').Shell }> {
    const { AgenticProcess } = await import('../process/agentic-process');
    const { dataContext } = await import('../FlowSync/context');

    const systemSkills = dataContext.bootstrapInfo?.desktop_info?.paths?.system_skills;
    const flowSkillPath = systemSkills
      ? `/${systemSkills}/flow/SKILL.md`
      : '~/.flow/system_assets/skills/flow/SKILL.md';
    const instruction = `Run workflow at /${this.source_vfs_path} using the flow skill located at: ${flowSkillPath}`;
    const workdir = dataContext.project?.fs_storage_mount_path;

    const { process, shell } = await AgenticProcess.spawn(
      { permissionMode: 'bypassPermissions', workdir, scope: [this.typeId] },
      { instruction },
    );
    return { process, shell: shell! };
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
