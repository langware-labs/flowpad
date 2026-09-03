/**
 * Every connection this box has, in one read.
 *
 * Bound to `compute_node/@local` like `llm-sources-service`, and guarded the same
 * way: on the hub the action does not exist, so this reports nothing rather than
 * erroring a screen.
 *
 * The list is composed by the BACKEND on purpose. The Connections screen used to
 * fetch four shapes and fold them itself, which meant the browser decided what
 * "connected" meant — and two surfaces then disagreed about the same key twice.
 */
import apiClient from '../client';
import { isHubOnly } from '../utils/hub-runtime';
import type { ConnectionSpec } from '../entities/connection-spec';

const ACTION = 'connections';

export class ConnectionsService {
  private readonly base: string;

  constructor(nodeTypeId: { type: string; id: string }) {
    this.base = `/graph/${nodeTypeId.type}/${nodeTypeId.id}/${ACTION}`;
  }

  /**
   * `projectId` adds that project's API-key credentials. Without one the answer
   * is honestly smaller: a credential is identified by `(project_id, env_var)`
   * and the server has no notion of "the selected project" — that lives here.
   */
  async list(projectId?: string): Promise<ConnectionSpec[] | null> {
    if (isHubOnly()) return null;
    const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    const data = await apiClient.get<{ connections?: ConnectionSpec[] }>(`${this.base}${query}`);
    return data?.connections ?? [];
  }

  /**
   * Ask the installed harness CLIs whether they are signed in.
   *
   * A WRITE, and separate from `list` for that reason: it mirrors each verdict
   * onto the box, so every surface stops saying "Not checked" — while `list`
   * stays a read that `require()` can afford. Costs a bounded local subprocess
   * per harness nobody has asked about yet; `force` asks all of them again.
   */
  async checkHarnessLogins(force = false): Promise<Record<string, string>> {
    if (isHubOnly()) return {};
    const data = await apiClient.post<{ checked?: Record<string, string> }>(
      `/graph/compute_node/@local/check-harness-logins`,
      { force },
    );
    return data?.checked ?? {};
  }
}

export const connectionsService = new ConnectionsService({ type: 'compute_node', id: '@local' });
