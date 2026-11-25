/**
 * Markdown sync — what `syncmd` says about a project's harness markdown files
 * (flow_sdk/app/actions/md_sync_action.py). `syncmd` is an optional command-line tool: a
 * missing or old one is a `state` of the answer, never a failed call.
 */
import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import { isHubOnly } from '../utils/hub-runtime';

/** `MdSyncState` in flow_sdk/schema/data_spec/md_sync_spec.py. */
export enum MdSyncState {
  OK = 'ok',
  UNAVAILABLE = 'unavailable',
  OUTDATED = 'outdated',
  NOT_A_REPO = 'not_a_repo',
  ERROR = 'error',
}

/** One group of equivalent files a sync would bring together. */
export interface MdSyncStale {
  name: string;
  kind: string;
  /** The file the others are brought to. */
  source: string;
  /** The files a sync writes. */
  targets: string[];
}

/** A source with files in the repo that is not synced. */
export interface MdSyncUnsynced {
  source: string;
  paths: string[];
}

export interface MdSyncStatus {
  state: MdSyncState;
  version: string;
  stale: MdSyncStale[];
  unsynced: MdSyncUnsynced[];
  /** On the answer to a sync: how many files it wrote. */
  written?: number | null;
  /** `unavailable` / `outdated`: the command that installs or updates syncmd. */
  install_hint: string;
  detail: string;
}

export class MdSyncService {
  constructor(private readonly node: { type: string; id: string }) {}

  private async call(subpath: string, projectId: string, body?: Record<string, unknown>): Promise<MdSyncStatus | null> {
    // The hub has no project folder of this machine to look at.
    if (isHubOnly()) return null;
    const action = new ActionInfo('md_sync', this.node.type, this.node.id, body ? 'POST' : 'GET');
    action.subpath = subpath;
    if (body) action.bodyParameters = { project_id: projectId, ...body };
    else action.queryParameters = { project_id: projectId };
    return (await dataManager.callAction<unknown, MdSyncStatus>(action)) ?? null;
  }

  /** What a sync of the project would do. Writes nothing. */
  status(projectId: string): Promise<MdSyncStatus | null> {
    return this.call('status', projectId);
  }

  /** Bring the stale files together; answers the status as it is now, with `written`. */
  sync(projectId: string): Promise<MdSyncStatus | null> {
    return this.call('sync', projectId, {});
  }

  /** Start syncing source `name` (saved in the project's syncmd.toml). */
  addSource(projectId: string, name: string): Promise<MdSyncStatus | null> {
    return this.call('source/add', projectId, { name });
  }
}

/** Ready-to-use singleton wired to the local compute node. */
export const mdSyncService = new MdSyncService({ type: 'compute_node', id: '@local' });
