import { APIEntity, registerEntity } from '../APIEntity';
import { dataContext } from '../FlowSync/context';
import { FrontMatterFsRef } from '../fs/FrontMatterFsRef';
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

  /** Description of the workflow */
  description?: string;

  /** VFS path to the workflow file (e.g., workflows/<uuid>/main.md) */
  asset_ref?: string;

  /** ID of the parent project */
  project_id?: string;

  /** Tab index for UI display (null = not in tabs, 0+ = tab position) */
  tab_index?: number | null;

  constructor(entity: Partial<Workflow> = {}) {
    super(entity);
    this.description = entity.description;
    this.asset_ref = entity.asset_ref;
    this.project_id = entity.project_id;
    this.tab_index = entity.tab_index ?? null;
  }

  override get dockPointer(): DockPointerData {
    return new DockPointerData(ViewType.WORKFLOWS, this.id);
  }

  /** FrontMatterFsRef for the workflow .md file at asset_ref. */
  get doc(): FrontMatterFsRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId || !this.asset_ref) return null;
    return new FrontMatterFsRef(this.asset_ref, typeId);
  }

  /**
   * Create a new workflow scoped to the given project. The backend
   * Entity.save() resolves scope from request_context, calls
   * ``WorkflowRecord.upsert_main_ref(self)`` which writes
   * ``<project>/.claude/workflows/<name>.md`` iff missing, and returns the
   * entity with ``asset_ref`` set. No fsManager.writeFile shortcut.
   */
  static async createInProject(
    project: { typeId?: TypeId } | null,
    name: string,
  ): Promise<Workflow> {
    const scopeIds = project?.typeId ? [project.typeId] : [];
    const workflow = new Workflow({ name: name.trim() });
    return workflow.save(scopeIds);
  }

  /** Backward-compat alias: create a workflow under the user-home scope. */
  static async create(name: string): Promise<Workflow> {
    return Workflow.createInProject(null, name);
  }

  /**
   * Rename this workflow: renames the linked file and updates name + asset_ref.
   */
  async rename(newName: string): Promise<void> {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === this.name) return;

    const { ComputeNode } = await import('./compute-node/compute-node');
    const computeNode = await ComputeNode.getById('@local');
    if (!computeNode) throw new Error('No local compute node');

    if (this.asset_ref) {
      const safeName = trimmed.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      await fsManager.rename(computeNode.typeId, this.asset_ref, `${safeName}.md`);
      const dir = this.asset_ref.replace(/\/[^/]+$/, '');
      this.asset_ref = `${dir}/${safeName}.md`;
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
    const instruction = `Run workflow at /${this.asset_ref} using the flow skill located at: ${flowSkillPath}`;
    const workdir = dataContext.project?.fs_storage_mount_path;

    const { process, shell } = await AgenticProcess.spawn(
      {
        permissionMode: 'bypassPermissions',
        workdir,
        scope: [this.typeId],
        targetVfsPath: this.typeId.toString(),
      },
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
