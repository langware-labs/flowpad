import { v4 as uuidv4 } from 'uuid';
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { QueryRequest } from '../FlowSync/query';
import { ActionInfo, TypeId } from '../models';
import { DockPointerData } from '../models/DockPointer';
import { ViewType } from '../utils/ui/view-types';
import { Agent } from './agent';
import { Artifact, IArtifact } from './artifact';
import { ComputeNode } from './compute_node';
import { Flow } from './flow/flow';
import { Workspace } from './workspace';

@registerEntity
export class Project extends APIEntity<Project> {
  static type: string = 'project';
  name?: string;
  fs_storage_mount_path?: string;
  computeNode?: ComputeNode | null = null;

  constructor(entity: Partial<Project> = {}) {
    super(entity);
    this.name = entity.name;
    this.fs_storage_mount_path = entity.fs_storage_mount_path;
  }

  get searchDockPointer(): DockPointerData {
    return new DockPointerData(ViewType.ASSETS, 'list/all', {
      scope: 'project',
      project_ids: this.id,
    });
  }

  /**
   * Get the display name for the project (folder basename, not full path)
   */
  get displayName(): string {
    if (!this.name || typeof this.name !== 'string') return 'New Project';
    // Extract the last part of the path (folder name)
    const parts = this.name.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] || this.name;
  }

  /**
   * Get the compute node associated with this project
   * @returns The ComputeNode instance or null if none exists
   */
  async getComputeNode(): Promise<ComputeNode | null> {
    if (this.computeNode) {
      return this.computeNode;
    }
    const actionInfo = new ActionInfo('get-compute-node', Project.type, this.typeId.id, 'GET');
    const responseComputeNode = await dataManager.callAction<void, { compute_node: any }>(actionInfo);

    if (!responseComputeNode?.compute_node) {
      return null;
    }
    const computeNode = dataManager.updateEntityFromJson<ComputeNode>(responseComputeNode.compute_node);
    this.computeNode = computeNode;
    return computeNode;
  }

  async setupComputeNode(options?: { gitRemoteRepoUrl?: string; gitBranch?: string }): Promise<ComputeNode | null> {
    const actionInfo = new ActionInfo('initialize', Project.type, this.typeId.id, 'POST');
    actionInfo.bodyParameters = {
      ...(options?.gitRemoteRepoUrl && { gitRemoteRepoUrl: options.gitRemoteRepoUrl }),
      ...(options?.gitBranch && { gitBranch: options.gitBranch }),
    };
    const response = await dataManager.callAction<typeof actionInfo.bodyParameters, { compute_node: any }>(actionInfo);

    if (!response || !response.compute_node) {
      return null;
    }

    const computeNode = dataManager.updateEntityFromJson<ComputeNode>(response.compute_node);
    return computeNode;
  }

  /**
   * Add an artifact to this project
   * @param artifactData - The artifact data to create
   * @returns The created Artifact instance
   */
  async addArtifact(artifactData: Partial<IArtifact>): Promise<Artifact> {
    const artifact = new Artifact({
      ...artifactData,
      project_id: this.id,
    });

    // Save the artifact with this project as the scope
    await artifact.save(this.typeId);

    return artifact;
  }

  /**
   * Delete an artifact from this project
   * @param artifactId - The ID of the artifact to delete
   * @returns True if deletion was successful
   */
  async deleteArtifact(artifactId: string): Promise<boolean> {
    const typeId = new TypeId(Artifact.type, artifactId);
    const artifact = await dataManager.getByTypeId<Artifact>(typeId);
    if (!artifact) {
      throw new Error(`Artifact with ID ${artifactId} not found`);
    }

    await artifact.delete();
    return true;
  }

  /**
   * Get all artifacts for this project
   * @returns Array of Artifact instances
   */
  async getArtifacts(): Promise<Artifact[]> {
    const query = new QueryRequest({
      type: Artifact.type,
      scope: [this.typeId],
    });

    const results = await dataManager.query<Artifact>(query);
    return results;
  }

  /**
   * Create a new flow in this project
   * @param agentId - The ID of the agent to use for the flow
   * @param sourceVfsPath - Optional VFS path of the source file (e.g., for skills)
   * @returns TypeId of the created flow
   */
  async createFlow(agentId: string, sourceVfsPath?: string): Promise<TypeId> {
    const processId = uuidv4();
    const flowTypeId = new TypeId(Flow.type, processId);
    const createFlowAction = new ActionInfo('create-flow', this.typeId.type, this.typeId.id, 'POST');
    createFlowAction.bodyParameters = {
      flow_id: processId,
      agent_id: agentId,
      ...(sourceVfsPath && { source_vfs_path: sourceVfsPath }),
    };
    createFlowAction.castResponse = true;

    await dataManager.callAction(createFlowAction);

    return flowTypeId;
  }

  /**
   * Find an existing flow by its source VFS path
   * @param sourceVfsPath - The VFS path to search for
   * @returns The Flow instance if found, or null
   */
  async getFlowBySource(sourceVfsPath: string): Promise<Flow | null> {
    const actionInfo = new ActionInfo('get-flow-by-source', Project.type, this.typeId.id, 'GET');
    actionInfo.queryParameters = { source_vfs_path: sourceVfsPath };

    const response = await dataManager.callAction<void, Flow | null>(actionInfo);

    if (!response) {
      return null;
    }

    // If response contains flow data, convert to Flow instance
    return dataManager.updateEntityFromJson<Flow>(response);
  }

  /**
   * Get or create a flow associated with an FSItem
   * If a flow exists for the item's VFS path, returns it
   * Otherwise creates a new flow and returns it
   * @param item - The FSItem to get/create flow for
   * @param agentId - The agent ID to use when creating a new flow
   * @returns The existing or newly created Flow instance
   */
  async getOrCreateFlowForItem(item: { vfs_abs_path: string }, agentId: string): Promise<Flow> {
    const sourceVfsPath = item.vfs_abs_path;

    // First try to find existing flow
    const existingFlow = await this.getFlowBySource(sourceVfsPath);
    if (existingFlow) {
      return existingFlow;
    }

    // Create new flow with source path
    const flowTypeId = await this.createFlow(agentId, sourceVfsPath);

    // Fetch and return the created flow
    const flow = await dataManager.getByTypeId<Flow>(flowTypeId);
    if (!flow) {
      throw new Error('Failed to create flow');
    }

    return flow;
  }

  /**
   * Setup desktop environment connections for this project.
   * Links the project to @local workspace, @local agent, and @local compute node.
   * Should be called after creating/opening a project in desktop mode.
   * @returns Object containing the connected workspace, agent, and compute_node
   */
  async setupForDesktop(): Promise<{
    workspace: Workspace | null;
    agent: Agent | null;
    compute_node: ComputeNode | null;
  }> {
    const actionInfo = new ActionInfo('setup-for-desktop', Project.type, this.typeId.id, 'POST');
    const response = await dataManager.callAction<
      void,
      {
        workspace: Workspace | null;
        agent: Agent | null;
        compute_node: ComputeNode | null;
      }
    >(actionInfo);

    return response || { workspace: null, agent: null, compute_node: null };
  }
}
