import { APIEntity, registerEntity } from '../APIEntity';
import { dataContext } from '../FlowSync/context';
import { FSRef } from '../fs/FSRef';
import { DockPointerData } from '../models/DockPointer';
import { TypeId } from '../models/TypeId';
import { AgenticProcess } from '../process/agentic-process';
import { ProcessKind } from '../process/process-types';

/**
 * DynamicWorkflow entity — an authored dynamic-workflow script asset (the
 * Workflow-tool JS definition), like a SubAgent or a Skill. Creatable/editable;
 * running it spawns a worker that executes the script and produces a
 * WorkflowRun. Mirrors a backend `Entity` of the same type — a cache, never the
 * origin (slick P3).
 */
@registerEntity
export class DynamicWorkflow extends APIEntity<DynamicWorkflow> {
  static type: string = 'dynamic_workflow';

  description: string = '';
  asset_ref?: string;

  constructor(entity: Partial<DynamicWorkflow> = {}) {
    super(entity);
    this.description = entity.description ?? '';
    this.asset_ref = entity.asset_ref;
  }

  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? this.defaultDockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? super.editorDockPointer;
  }


  /** Create a new dynamic workflow under the given project (or user-home).
   *  The backend materializes the starter `.js` script at its asset_ref. */
  static async createInProject(
    project: { typeId?: TypeId } | null,
    name: string,
  ): Promise<DynamicWorkflow> {
    const scopeIds = project?.typeId ? [project.typeId] : [];
    return new DynamicWorkflow({ name: name.trim() }).save(scopeIds);
  }

  /** FsRef for the .js script. Resolves compute node from dataContext. */
  get doc(): FSRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId || !this.asset_ref) return null;
    return new FSRef(this.asset_ref, typeId);
  }

  /**
   * Run THIS workflow by launching a Claude worker that executes its script via
   * the Workflow tool. Reuses `AgenticProcess.launch` (slick P4 — no parallel
   * launch action) and tags the process with `target_typeid_str = this.typeId`
   * + `process_type = Execution`, so the run shows up in this workflow's
   * `EntityExecutionPanel` (`useProcessesForTarget`) — the same "runs of this
   * entity" surface the SubAgent/Skill/Workflow editors use. `ptyMode:true` opens a
   * visible terminal; `ptyMode:false` runs headlessly. The execution produces a
   * WorkflowRun once its journal lands on disk.
   */
  async run(
    project?: { id?: string; fs_storage_mount_path?: string | null } | null,
    opts?: { ptyMode?: boolean },
  ): Promise<AgenticProcess> {
    const proj = project ?? dataContext.project;
    const where = this.asset_ref ? `the workflow script at ${this.asset_ref}` : `the workflow "${this.name}"`;
    const launchPrompt = `Run ${where} using the Workflow tool (pass it via scriptPath if a path is given).`;
    return AgenticProcess.launch({
      workerType: 'claude_code',
      workdir: proj?.fs_storage_mount_path ?? '',
      projectId: proj?.id ?? null,
      launchPrompt,
      processType: ProcessKind.Execution,
      target: this.typeId.toString(),
      ptyMode: opts?.ptyMode !== false,
    });
  }
}
