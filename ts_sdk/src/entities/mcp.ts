import { APIEntity, registerEntity } from '../APIEntity';
import { DockPointerData } from '../models/DockPointer';

/**
 * Where an MCP server's implementation comes from — the thing a user actually
 * chooses when creating one. DERIVED, never stored: a second type-ish field
 * beside `transport` would be one more thing to keep in agreement.
 */
export type McpShape = 'bundled' | 'command' | 'remote';

/** The default file a bundled server's code is scaffolded into (backend mirror). */
export const MCP_DEFAULT_ENTRYPOINT = 'server.py';

/** What each shape sets. `command` sets nothing — the class defaults already
 *  describe "stdio, and you fill in the command". */
const SHAPE_FIELDS: Record<McpShape, Partial<Mcp>> = {
  bundled: { transport: 'stdio', command: 'fastmcp', args: ['run'], entrypoint: MCP_DEFAULT_ENTRYPOINT },
  command: {},
  remote: { transport: 'http' },
};

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
  entrypoint: string = '';
  asset_ref?: string;

  constructor(entity: Partial<Mcp> = {}) {
    super(entity);
    this.transport = entity.transport ?? 'stdio';
    this.command = entity.command ?? '';
    this.args = entity.args ?? [];
    this.env = entity.env ?? {};
    this.url = entity.url ?? '';
    this.entrypoint = entity.entrypoint ?? '';
    this.asset_ref = entity.asset_ref;
  }

  get isRemote(): boolean {
    return isRemoteTransport(this.transport, this.url, this.command);
  }

  /**
   * Connect to this server and list its tools.
   * `ok: false` is a normal answer — a broken command is reported, not thrown.
   */
  async test(): Promise<{ ok: boolean; tools: string[]; detail: string }> {
    return this.post('test');
  }

  /**
   * Create an MCP asset in a project. The backend materializes
   * `<project>/agentic-assets/mcp/<name>/mcp.json` from the type's `asset_spec`
   * on save — mirrors `Whiteboard.createInProject`.
   */
  static async createInProject(
    project: { typeId?: import('../models/TypeId').TypeId } | null,
    name: string,
    shape: McpShape = 'bundled',
  ): Promise<Mcp> {
    const scopeIds = project?.typeId ? [project.typeId] : [];
    // `bundled` is the default because the name-only create paths (the assets
    // list `+`, the CLI) cannot ask — and of the three, it is the only one that
    // produces something that runs without further typing.
    return new Mcp({ name: name.trim(), ...SHAPE_FIELDS[shape] }).save(scopeIds);
  }

  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? this.defaultDockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? super.editorDockPointer;
  }
}
