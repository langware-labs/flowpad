import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { QueryRequest } from '../FlowSync/query';
import { ActionInfo, TypeId } from '../models';
import { DockPointerData } from '../models/DockPointer';
import { ViewType } from '../utils/ui/view-types';
import { Agent } from './agent';
import { Artifact, IArtifact } from './artifact';
import { ComputeNode } from './compute_node';
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
