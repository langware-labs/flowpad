import { APIEntity, registerEntity } from '../APIEntity';
import { DockPointerData } from '../models/DockPointer';

/** Remote transports, mirroring `mcp_spec.REMOTE_TRANSPORTS`. */
const REMOTE_TRANSPORTS = ['http', 'sse'];

/**
 * Is this server dialled rather than launched? The ONE definition — the rule
 * decides which fields an editor may offer, so a second, weaker copy produces
 * specs the projector reads differently than the form showed.
 *
 * Mirrors `McpSpec.is_remote` (flow_sdk/schema/data_spec/mcp_spec.py).
 */
export function isRemoteTransport(transport: string, url: string, command: string): boolean {
  return REMOTE_TRANSPORTS.includes(transport) || (!!url && !command);
}

/**
 * Mcp entity — FlowPad's OWN authored MCP-server asset, backed by
 * `<scope>/agentic-assets/mcp/<name>/mcp.json` (an `McpSpec`).
 *
 * Distinct from `mcp_server`, which is the READ-ONLY inventory of servers
 * already configured in a vendor's own files (`~/.claude.json`,
 * `.codex/config.toml`, …). That one records a definition site we do not own;
 * this one is ours end to end and is what an Agent attaches.
 *
 * `asset_ref` is the FOLDER (the type is folder-backed with `mcp.json` as its
 * main file), so a viewer names its own file off it — the same move as
 * Whiteboard and Deck.
 */
@registerEntity
export class Mcp extends APIEntity<Mcp> {
  static type: string = 'mcp';
  static override icon = 'Plug';

  transport: string = 'stdio';
  command: string = '';
  args: string[] = [];
  env: Record<string, string> = {};
  url: string = '';
  asset_ref?: string;

  constructor(entity: Partial<Mcp> = {}) {
    super(entity);
    this.transport = entity.transport ?? 'stdio';
    this.command = entity.command ?? '';
    this.args = entity.args ?? [];
    this.env = entity.env ?? {};
    this.url = entity.url ?? '';
    this.asset_ref = entity.asset_ref;
  }

  get isRemote(): boolean {
    return isRemoteTransport(this.transport, this.url, this.command);
  }

  /**
   * Create an MCP asset in a project. The backend materializes
   * `<project>/agentic-assets/mcp/<name>/mcp.json` from the type's `asset_spec`
   * on save — mirrors `Whiteboard.createInProject`.
   */
  static async createInProject(
    project: { typeId?: import('../models/TypeId').TypeId } | null,
    name: string,
  ): Promise<Mcp> {
    const scopeIds = project?.typeId ? [project.typeId] : [];
    return new Mcp({ name: name.trim() }).save(scopeIds);
  }

  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? this.defaultDockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? super.editorDockPointer;
  }
}
