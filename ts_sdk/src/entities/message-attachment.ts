import { APIEntity, dataManager, registerEntity, type ReceiveShowTarget } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { TypeId } from '../models/TypeId';

/** null = staged only (downloaded, reviewable, NOT installed/indexed). */
export type MessageAttachmentScope = 'user' | 'project' | null;

export interface StagedFileInfo {
  path: string;
  size?: number;
  is_main?: boolean;
}

export interface StagedFilesResponse {
  files: StagedFileInfo[];
  main_file: string | null;
  root: string;
  /** Absolute staged dir on the local machine (Test-it references it by path). */
  abs_root: string;
}

export interface StagedFileContent {
  path: string;
  content: string;
  truncated: boolean;
}

// The DisplayTarget shape returned by install()/setup() lives on APIEntity (it is
// generic to every entity); re-exported here for the historical import path.
export type { ReceiveShowTarget } from '../APIEntity';

/**
 * A received, staged bundle attachment awaiting explicit install.
 *
 * Minted backend-side when a message's `.flowmsg` bundle is unpacked; the
 * asset's bytes stay in the message's staging area (not indexed, not visible
 * to agents) until the user installs it via `install()`. Mirrors
 * `flow_sdk/builtin/message_attachment.py`.
 */
export interface IMessageAttachment extends IEntity {
  flow_message_id?: string;
  conversation_id?: string | null;
  /** The shared asset's identity as sent (sender-pinned id). */
  asset_type?: string;
  asset_id?: string;
  name?: string | null;
  description?: string | null;
  /** Staging path RELATIVE to the message's data dir. */
  unpacked_path?: string;
  /** Whether "Install global" (user scope) is offered — schema-derived and
   *  stamped backend-side at stage time (single source of the policy). */
  user_scope_allowed?: boolean;
  transfer_mode?: 'copy' | 'git';
  origin?: Record<string, unknown> | null;
  scope?: MessageAttachmentScope;
  project_id?: string | null;
  installed_root?: string | null;
  installed_at?: string | null;
}

@registerEntity
export class MessageAttachment extends APIEntity<MessageAttachment> implements IMessageAttachment {
  static type: string = 'message_attachment';

  flow_message_id?: string;
  conversation_id?: string | null;
  asset_type?: string;
  asset_id?: string;
  name?: string | null;
  description?: string | null;
  unpacked_path?: string;
  user_scope_allowed?: boolean;
  transfer_mode?: 'copy' | 'git';
  origin?: Record<string, unknown> | null;
  scope?: MessageAttachmentScope;
  project_id?: string | null;
  installed_root?: string | null;
  installed_at?: string | null;

  constructor(entity: Partial<IMessageAttachment> = {}) {
    super(entity);
    this.flow_message_id = entity.flow_message_id;
    this.conversation_id = entity.conversation_id ?? null;
    this.asset_type = entity.asset_type;
    this.asset_id = entity.asset_id;
    this.name = entity.name ?? null;
    this.description = entity.description ?? null;
    this.unpacked_path = entity.unpacked_path;
    this.user_scope_allowed = entity.user_scope_allowed ?? true;
    this.transfer_mode = entity.transfer_mode ?? 'copy';
    this.origin = entity.origin ?? null;
    // '' is the backend's CLEARED form (exclude-none saves can't null a field)
    // — normalize to null so every consumer sees one "staged" value.
    this.scope = entity.scope || null;
    this.project_id = entity.project_id || null;
    this.installed_root = entity.installed_root ?? null;
    this.installed_at = entity.installed_at ?? null;
  }

  /** Parsed TypeId of the shared asset, or null when incomplete. */
  get targetTypeId(): TypeId | null {
    if (!this.asset_type || !this.asset_id) return null;
    return new TypeId(this.asset_type, this.asset_id);
  }

  /** Canonical install-state accessor. The backend clears scope with `''`
   *  (exclude-none saves can't null a field) and WS updates can land that
   *  cleared form directly on the cached instance, bypassing the constructor —
   *  so state decisions must read THIS, never `.scope` directly. */
  get effectiveScope(): 'user' | 'project' | null {
    return this.scope || null;
  }

  get installed(): boolean {
    return this.effectiveScope != null;
  }

  /**
   * Materialize the staged asset. Copy mode: copy bytes into the chosen scope
   * root, index, and run the per-type reception setup. Git mode ("Download"):
   * clone/pull the origin and index — setup does NOT run (call {@link runSetup}
   * explicitly). Returns the DisplayTarget to navigate to (the received entity,
   * or — copy mode only — a spawned Vibe setup session), or null.
   */
  async install(
    scope: 'user' | 'project',
    projectId?: string,
    opts: { overwrite?: boolean } = {},
  ): Promise<ReceiveShowTarget | null> {
    if (!this.id) throw new Error('install requires this.id');
    const action = new ActionInfo('install', MessageAttachment.type, this.id, 'POST');
    action.bodyParameters = {
      scope,
      project_id: projectId ?? null,
      overwrite: opts.overwrite ?? false,
    };
    const res = await dataManager.callAction<unknown, { entity?: unknown; show?: ReceiveShowTarget | null }>(action);
    return res?.show ?? null;
  }

  /**
   * Run the received asset's optional setup — explicit, receiver-initiated.
   * Git-shared assets never auto-run setup on Download; the reception UI surfaces
   * a separate "Set up"/"Run" action (per ``TypeInfo.reception_verb``) that calls
   * this. Returns the DisplayTarget (a spawned setup session, or the entity when
   * the type has no setup skill), routed through ``openDisplayTarget``.
   */
  async runSetup(): Promise<ReceiveShowTarget | null> {
    if (!this.id) throw new Error('runSetup requires this.id');
    const action = new ActionInfo('setup', MessageAttachment.type, this.id, 'POST');
    const res = await dataManager.callAction<unknown, { entity?: unknown; show?: ReceiveShowTarget | null }>(action);
    return res?.show ?? null;
  }

  /** Remove the installed copy (staged copy persists; chip reverts to staged). */
  async uninstall(): Promise<this> {
    if (!this.id) throw new Error('uninstall requires this.id');
    const action = new ActionInfo('uninstall', MessageAttachment.type, this.id, 'POST');
    await dataManager.callAction<unknown, unknown>(action);
    return this;
  }

  /** List the staged files for the review modal. */
  async listStagedFiles(): Promise<StagedFilesResponse> {
    if (!this.id) throw new Error('listStagedFiles requires this.id');
    const action = new ActionInfo('staged-files', MessageAttachment.type, this.id, 'GET');
    return await dataManager.callAction<unknown, StagedFilesResponse>(action);
  }

  /** Read one staged file's text content (rel path from listStagedFiles). */
  async readStagedFile(relPath: string): Promise<StagedFileContent> {
    if (!this.id) throw new Error('readStagedFile requires this.id');
    const action = new ActionInfo('staged-file-content', MessageAttachment.type, this.id, 'GET');
    action.queryParameters = { path: relPath };
    return await dataManager.callAction<unknown, StagedFileContent>(action);
  }
}
