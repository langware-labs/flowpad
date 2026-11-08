import { launchSurfaceField } from '../process/launch-surface';
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { QueryFilter, QueryRequest } from '../FlowSync/query';
import type { AgenticProcess } from '../process/agentic-process';
import { lastChatQuery, recencyOf } from '../process/last-chat';
import { ActionInfo } from '../models/ActionInfo';
import { TypeId } from '../models/TypeId';
import { isHubOnly } from '../utils/hub-runtime';
import type { GitOrigin } from '../models/GitOrigin';
import type { HubRepoOrigin } from '../models/FSOrigin';
import type { PromptResult } from '../models/ReturnedValue';
import { FrontMatterFsRef } from '../fs/FrontMatterFsRef';
import { DockPointerData } from '../models/DockPointer';
import { mainFileForType } from '../models/asset-editor';
import { dataContext } from '../FlowSync/context';
import { AGENT_AVATAR_FILE, AGENT_AVATAR_REF } from './agent-avatar';
import type { ActivityProgressSpec } from '../activity';
import { Deployment, type IDeployment } from './deployment';

/** A hub compute provider a cloud deployment lands on, by the hub's own name — sent to the hub as-is. */
export type CloudDeployProvider = string;
import { DataSource, type IDataSource } from './data-source';
import { AgentMailbox, type IAgentMailbox } from './agent-mailbox';
import { Trigger } from './trigger';

export { AGENT_AVATAR_FILE, AGENT_AVATAR_REF } from './agent-avatar';

/** One entry of `GET /agent/<id>/assistant_skill_catalog`. */
export interface AssistantSkillChoice {
  /** The skill's folder name — what `assistant_skills` lists. */
  name: string;
  description: string;
}

/** `GET /agent/<id>/auto_launch_state`. */
export interface AgentAutoLaunchState {
  /** Already auto-launched in the agent's own project; `null` when it has no project. */
  launched: boolean | null;
}

/**
 * The launchable agent — identity (name / avatar / system prompt) plus the
 * launch bundle, mirroring `flow_sdk/builtin/agent.py`.
 *
 * NOT a `SubAgent`. That is the provider-owned `.claude/agents/<name>.md`
 * prompt asset Claude Code reads directly; this is the thing that *deploys and
 * runs*, and may delegate to SubAgents by name through `subagents`.
 *
 * Registering this class is load-bearing, not cosmetic: `EntityFactory` drops
 * rows whose constructor is missing (`FlowSync/store.ts` — "Skipping entity,
 * constructor not found for type"), so without it every `agent` row fetched
 * from the backend is silently discarded client-side.
 *
 * The entity projects agent.json (+ system_prompt.md) for actions and launching. File editors use the
 * revision-checked FS document action to preserve unknown metadata and identity
 * capsules. The backend refreshes this projection after a document write.
 * `system_prompt` is the Markdown body; profile controls submit typed field patches.
 */
/** One thing an agent needs (`agent.requirement`). Never a value. */
export interface AgentRequirement {
  kind: 'credential' | 'permission' | 'connection' | 'variable' | 'funding';
  name: string;
  vars: string[];
  scopes: string[];
  on: string;
  why: string;
  derived: boolean;
  used_by: string[];
}

/** One requirement at one deployment: `verified` (checked), `declared` (present, unverifiable) or `missing`. */
/**
 * A cloud deployment's own token budget: a hub LLM endpoint drawn from `source` (one the caller administers),
 * capped at `cost_usd_per_day`, allowing only `model` — which the deployed agent then runs.
 */
export interface AgentTokenAllocation {
  source: string;
  cost_usd_per_day?: number | null;
  model: string;
}

/** Who may open a public deployment: anyone with the `/open-pc/<id>` link, or only a holder of an invite code. */
export type PublicDeploymentMode = 'link' | 'code';

/** The hub's public-deployment settings on an agent (`agent/<id>/public_deployments`). */
export interface PublicDeploymentSettings {
  allow_visitor_deployment: boolean;
  mode: PublicDeploymentMode;
  max_deployments: number | null;
  wrong_code_limit_per_hour: number;
  llm_source: string | null;
  cap_usd: number | null;
}

/** The body of `enable_public_deployments`: `llm_source` and `cap_usd` come together or not at all. */
export interface PublicDeploymentSetup {
  mode: PublicDeploymentMode;
  max_deployments: number | null;
  wrong_code_limit_per_hour?: number;
  /** Required: every public box is funded, so a visitor is never asked for a token source. */
  llm_source: string;
  cap_usd: number;
}

/** One invite code, as the owner sees it: never the code itself, only its last four characters. */
export interface PublicInviteCode {
  id: string;
  last4: string;
  state: 'unused' | 'in_use' | 'revoked';
  node_typeid: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** A freshly minted code: the only time its plaintext is ever answered. */
export interface NewPublicInviteCode {
  id: string;
  code: string;
  last4: string;
}

/** One visitor's box. `code_id` is null for a link visitor. */
export interface PublicDeployment {
  node_typeid: string;
  name: string;
  status: string;
  code_id: string | null;
  code_last4: string | null;
  created_date: string | null;
  last_used_at: string | null;
  /** IT Sessions on that machine, when the hub reports it (null/absent = not known yet). */
  it_sessions?: boolean | null;
}

export interface PublicDeploymentsState {
  settings: PublicDeploymentSettings | null;
  codes: PublicInviteCode[];
  deployments: PublicDeployment[];
}

export type PublicDeploymentOp = 'open' | 'pause' | 'resume' | 'reset';

/** Which public machines an IT message (or an IT Sessions switch) reaches: all of them, or these `node_typeid`s. */
export type ItTargets = 'all' | string[];

/** A file an IT message carries to each machine. */
export interface ItAttachment {
  name: string;
  content_b64: string;
}

export interface ItMessageRequest {
  text: string;
  attachments?: ItAttachment[];
  /** A JSON shape each machine's answer value must match; null for a plain answer. */
  answer_shape?: Record<string, unknown> | null;
  targets: ItTargets;
  /** Append to this IT conversation instead of opening a new one. */
  conversation_id?: string;
}

export interface ItMessageResult {
  conversation_id: string;
  targets: string[];
}

export interface ItSessionsBox {
  node_typeid: string;
  on: boolean;
  error?: string;
}

/** A machine's reply in an IT conversation, as the hub stamps it on the message (`metadata.it`). */
export type ItReplyState = 'done' | 'off' | 'signed_in' | 'unreachable';

export interface ItReplyMeta {
  node_typeid: string;
  code_last4: string | null;
  state: ItReplyState;
  woke?: boolean;
  value?: Record<string, unknown> | null;
  call_id?: string;
}

export interface PublicDeploymentOpResult {
  node_typeid: string;
  workspace_url?: string;
  status?: string;
}

export interface AgentReadinessItem {
  requirement: AgentRequirement;
  status: 'verified' | 'declared' | 'missing';
  where: string;
  /** The variables a store must hold for it — empty for what a grant satisfies. */
  vars: string[];
  /** Which of `vars` the store lacks — what "use mine" copies. */
  missing: string[];
  /** The connection that grants it — what a cloud deployment's owner authorizes for its machine. */
  connection: string;
  fix: string;
  /** The fix as a verb: `use_mine` (copy this computer's value), `authorize` (grant `connection`), or empty. */
  remedy: '' | 'use_mine' | 'authorize';
}

export interface AgentReadiness {
  agent_id: string;
  deployment_id: string;
  environment: string;
  ready: boolean;
  items: AgentReadinessItem[];
}

/** A planned cloud placement and its readiness (`POST agent/<id>/plan_deployment`). */
export interface AgentPlannedDeployment {
  deployment: IDeployment;
  readiness: AgentReadiness;
}

/** Agents known to live only on the hub (made there, no row on this computer): their mailbox is the hub's door. */
const hubHeld = new WeakSet<Agent>();

@registerEntity
export class Agent extends APIEntity<Agent> {
  /** An agent the hub holds and this computer does not — e.g. one the hub just made for the hub page. */
  static onHub(data: ConstructorParameters<typeof Agent>[0]): Agent {
    const agent = new Agent(data);
    hubHeld.add(agent);
    return agent;
  }

  /** Its mailbox is answered by the hub: on the hub page, or when only the hub holds it. */
  private get mailboxOnHub(): boolean {
    return isHubOnly() || hubHeld.has(this);
  }

  static type: string = 'agent';

  // ── identity / presentation ────────────────────────────────────────────
  name?: string;
  description?: string;
  /** Emoji (`🩺`) or a lucide icon name — the same one-string contract
   *  `IconPicker` stores and `AvatarValue` renders. */
  avatar?: string | null;
  /** Avatar circle background — a palette hex (`ColorPicker`). Unset = derived
   *  from the agent's name. */
  color?: string | null;
  /** Who this agent is. Delivered to the worker via `context_data.instructions`;
   *  on disk it is `system_prompt.md` beside `agent.json`. */
  system_prompt?: string;

  // ── launch bundle ──────────────────────────────────────────────────────
  /** The DRIVER short-id an agent.json declares: `claude` | `codex` | `copilot`.
   *  Deliberately NOT the `AgentConfig.WorkerType` vocabulary (`claude_code`),
   *  which is what `AgenticProcess.worker_type` stores. Feeding one where the
   *  other belongs is a real, previously-shipped bug. */
  worker_type?: string;
  /** A tier (`sm`/`md`/`lg`) or a concrete model id. */
  model?: string;
  permission_mode?: string;
  effort?: string;
  /** Cloud box size (`sm`/`md`/`lg`) the hub deploys this agent onto. */
  machine_size?: string;
  max_turns?: number;

  // `null`/undefined is NOT `[]` — an omitted list inherits everything the
  // harness allows, an empty list revokes it. Never normalize one to the other.
  tools?: string[] | null;
  disallowed_tools?: string[] | null;
  skills: string[];
  mcp_servers: string[];
  /** SubAgent NAMES this agent may delegate to. */
  subagents: string[];
  additional_dirs: string[];
  load_flowpad_assistant: boolean;
  /** Which Flowpad Assistant skills it loads, by folder name; `null`/absent = all of them. */
  assistant_skills?: string[] | null;
  /** Chief of Staff mode: answers fast and delegates long work to its subagents as tasks. */
  chief_of_staff: boolean;
  /** Vendor-specific launch keys the schema does not enumerate (e.g. Claude's
   *  `chrome: true`). Nested by nature — which is why this type must never be
   *  round-tripped through the markdown frontmatter editor. */
  cli_options: Record<string, unknown>;

  // ── lifecycle ──────────────────────────────────────────────────────────
  enabled: boolean;
  /** Absolute on-disk path to the agent's folder (`agent.json` sits inside). */
  asset_ref?: string;
  /** One of Flowpad's own agents (ships inside a system project) — backend-computed, read-only.
   *  Absent on hub rows, which reads as not shipped. */
  shipped?: boolean;
  /** The project holding this agent; null for one in the user scope, which cannot be deployed to the cloud. */
  project_id?: string | null;
  /** Where the hub keeps this agent's files. A published agent lives in its project's
   *  hub-hosted repository (`kind: 'hub_repo'`, the agent's folder as `rel_path`); an
   *  agent published before that carries a GitHub `kind: 'git'` origin. Hub-written
   *  provenance — absent on desktop rows and on agents never published. `/launch?agent=`
   *  reads it to know which repository to launch. */
  git_origin?: GitOrigin | HubRepoOrigin | null;

  // ── presentation + project auto-launch ─────────────────────────────────
  /** Welcome text rendered as the agent's first message in Vibe/Standard chat.
   *  Presentation only — never part of the transcript, never sent to the model. */
  intro?: string;
  /** `intro` in other languages, keyed by locale code (`he`, `ar`, `en-US`). */
  intro_translations: Record<string, string>;
  /** Launch once, the first time the project this agent lives in is opened.
   *  Oldest wins when several agents in a project set it; the rest are
   *  cancelled with a warning. See `Agent.auto_launch_for` (backend). */
  auto_launch: boolean;
  /** The agent's auto prompt: the first turn of every new session opened as it
   *  with `use(…, true)` — auto-launch included — delivered via
   *  the prompt queue. Independent of `auto_launch`. */
  auto_launch_prompt?: string;
  /** Sessions as this agent stay in Vibe: no tab strip, no switch to Chat or Terminal. */
  vibe_only: boolean;
  /** The empty Vibe display's starter chips for sessions as this agent; a chip's text is
   *  the prompt it sends. Empty = the generic starters. */
  starter_prompts: string[];
  /** What every new session as this agent opens with: a place (`Tab.pointer` JSON, a
   *  file named inside the agent's project), a `navigate` compute op in the agent's
   *  project that repairs it when it cannot be used yet (`{op}`), or a wizard
   *  (`{wizard}`). The first place is the session's active display. Opened and
   *  repaired by the backend (`Agent.use`); the frontend only renders them. */
  auto_open?: ({ viewType: string; pointer: string } | { op: string } | { wizard: string })[] | null;
  /** The agent's own phone number (agent.json `phone`) — declaration only. */
  phone?: PhoneNumberWire | null;

  constructor(entity: Partial<Agent> = {}) {
    super(entity);
    this.name = entity.name;
    this.description = entity.description;
    this.avatar = entity.avatar;
    this.color = entity.color;
    this.system_prompt = entity.system_prompt;

    this.worker_type = entity.worker_type;
    this.model = entity.model;
    this.permission_mode = entity.permission_mode;
    this.effort = entity.effort;
    this.machine_size = entity.machine_size;
    this.max_turns = entity.max_turns;

    // Preserve the tri-state: absent stays absent, [] stays [].
    this.tools = entity.tools;
    this.disallowed_tools = entity.disallowed_tools;
    this.skills = entity.skills || [];
    this.mcp_servers = entity.mcp_servers || [];
    this.subagents = entity.subagents || [];
    this.additional_dirs = entity.additional_dirs || [];
    this.load_flowpad_assistant = entity.load_flowpad_assistant ?? false;
    this.assistant_skills = entity.assistant_skills ?? null;
    this.chief_of_staff = entity.chief_of_staff ?? false;
    this.cli_options = entity.cli_options || {};

    this.enabled = entity.enabled ?? true;
    this.asset_ref = entity.asset_ref;
    this.shipped = entity.shipped;
    this.project_id = entity.project_id ?? null;
    this.git_origin = entity.git_origin;

    this.intro = entity.intro;
    this.intro_translations = entity.intro_translations || {};
    this.auto_launch = entity.auto_launch ?? false;
    this.auto_launch_prompt = entity.auto_launch_prompt;
    this.vibe_only = entity.vibe_only ?? false;
    this.starter_prompts = entity.starter_prompts ?? [];
    this.auto_open = entity.auto_open ?? null;
    this.phone = entity.phone ?? null;
  }

  /**
   * An agent is addressed by its slug (`name`) but PRESENTED by its title — the
   * chat identity row, the pinned asset row, lists. Falls back to the default
   * chain (name → uname → …) when no title was authored.
   */
  override getDisplayName(): string | null {
    return this.title?.trim() || null;
  }

  /** Default open target: the agent profile editor (URL-first navigate target). */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? this.defaultDockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.dockPointer;
  }

  /** File accessor; structured edits use readDocument()/updateDocument(). */
  get doc(): FrontMatterFsRef | null {
    const typeId = dataContext.computeNodeTypeId;
    const directory = this.bundleDirectory;
    if (!typeId || !directory) return null;
    return new FrontMatterFsRef(`${directory}/${mainFileForType(Agent.type, 'agent.json')}`, typeId);
  }

  /** Directory containing the portable Agent bundle: `asset_ref` (a row from
   *  before the unification may still name the inner main file). */
  get bundleDirectory(): string | null {
    // `asset_ref` is stored natively (backslashes on Windows) but `FSRef.parent`
    // splits on `/` only.
    const normalized = this.asset_ref?.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized) return null;
    const main = mainFileForType(Agent.type, 'agent.json') as string;
    if (normalized === main) return '.';
    if (normalized.endsWith(`/${main}`)) return normalized.slice(0, -(main.length + 1)) || '/';
    return normalized;
  }

  /** Resolved carrier path for the canonical portable avatar reference. */
  get avatarAssetRef(): string | null {
    const directory = this.bundleDirectory;
    if (this.avatar !== AGENT_AVATAR_REF || !directory) return null;
    if (directory === '/') return `/${AGENT_AVATAR_FILE}`;
    return `${directory}/${AGENT_AVATAR_FILE}`;
  }

  /**
   * Download URL of the uploaded avatar image, or null when the avatar is an
   * emoji / icon name (render `avatar` through `AvatarValue` then). THE one
   * predicate for "does this agent have a picture" — every surface that draws
   * an agent avatar reads this, so they cannot disagree on it.
   */
  get avatarImageUrl(): string | null {
    if (this.avatar !== AGENT_AVATAR_REF) return null;
    return this.doc?.parent.child(AGENT_AVATAR_FILE).getDownloadUrl() ?? null;
  }

  /** The agents a rule on this machine may run: enabled, by name — what a picker offers
   *  (`Agent.runnable_here` in Python). */
  static async runnableHere(): Promise<Agent[]> {
    const request = new QueryRequest({
      type: Agent.type,
      scope: [],
      name: 'agents:runnable-here',
      query: new QueryFilter({ match: { enabled: true } }),
    });
    const rows = await Agent.query(request, true);
    return rows.sort((a, b) => (a.name || '').localeCompare(b.name || '') || String(a.id).localeCompare(String(b.id)));
  }

  /** Create in the selected scope, optionally at an exact authorized folder. */
  static async createInProject(
    project: { typeId?: TypeId } | null,
    name: string,
    destination?: import('../fs/FSRef').FSRefJson,
  ): Promise<Agent> {
    const scopeIds = project?.typeId ? [project.typeId] : [];
    const agent = new Agent({ name: name.trim() });
    return agent.save(scopeIds, destination);
  }

  /**
   * Run this agent once, returning the process that records the run.
   *
   * An ActionInfo rather than a field write — this is a command, not CRUD
   * (the `set-kind` action on SubAgent is the same pattern). The backend
   * routes it to the compute node this agent's deployment places it on, so a
   * remote deployment fails loudly here rather than quietly running on the
   * server.
   */
  async run(prompt: string): Promise<PromptResult> {
    // The launch's own answer: `executor` names the process to navigate to;
    // `exit_code` says whether the first turn was accepted (and, when not, why).
    return (await this.post('run', { prompt })) as PromptResult;
  }

  /** Launch admission: OK means accepted; executor names the process to observe.
   * Unlike the legacy run method, a held slot is returned as a FlowCall answer.
   */
  async launch(prompt: string): Promise<PromptResult> {
    const action = new ActionInfo('run', Agent.type, this.id, 'POST');
    action.bodyParameters = { prompt };
    return dataManager.callFlowAction<PromptResult>(action);
  }

  /**
   * Add a scheduled run: a child trigger asset under this agent's folder that
   * runs the agent headlessly with `prompt`. Indexed and armed before it
   * returns, so the row it hands back is already live.
   */
  async addSchedule(fields: AgentScheduleFields & { name: string; expr: string; prompt: string }): Promise<Trigger> {
    return new Trigger((await this.post('add_schedule', { ...fields })) as Partial<Trigger>);
  }

  /** Change one of this agent's schedules. Only the fields given change. */
  async updateSchedule(triggerId: string, fields: AgentScheduleFields): Promise<Trigger> {
    return new Trigger((await this.post('update_schedule', { trigger_id: triggerId, ...fields })) as Partial<Trigger>);
  }

  /** Remove one of this agent's schedules — its folder, row and job. */
  async removeSchedule(triggerId: string): Promise<void> {
    await this.post('remove_schedule', { trigger_id: triggerId });
  }

  /**
   * Open a session AS this agent: a new, visible, headless Chat process built
   * from the agent's local deployment, with no turn started.
   * `POST /agent/<id>/use`. The counterpart of `run` (one prompt, headless).
   *
   * `projectId` is the project the session should ACT IN, which is not always
   * the project the agent lives in: an agent supplied by a help desk added
   * as a dependency belongs to the desk's checkout, but the session has to
   * open on the customer's project. Omit it and the backend falls back to the
   * agent's own project.
   *
   * `autoPrompt` queues the agent's auto prompt as the first turn. It is
   * queued, not sent: start it with `drainQueue()` (the UI's
   * `prepareAgentSession` does, after the vibe embed) BEFORE sending your own
   * prompt, or the auto prompt runs second.
   */
  async use(projectId?: string | null, autoPrompt = false): Promise<AgentUseResult> {
    return (await this.post('use', {
      project_id: projectId ?? null,
      ...autoPromptBody(autoPrompt),
      ...launchSurfaceField(),
    })) as AgentUseResult;
  }

  /** This agent's opened chats in `projectId`, newest first (at most `limit`). */
  async recentChats(projectId: string, limit = 20): Promise<AgenticProcess[]> {
    const rows = await dataManager.query<AgenticProcess>(lastChatQuery(projectId, this.typeId.toString()));
    return [...rows].sort((a, b) => recencyOf(b) - recencyOf(a)).slice(0, limit);
  }

  /** This agent's last opened chat in `projectId`, or null — the rule every opener shares (`lastChatQuery`). */
  async lastChat(projectId: string): Promise<AgenticProcess | null> {
    return (await this.recentChats(projectId, 1))[0] ?? null;
  }

  /**
   * A NEW chat with this agent in `projectId`, started: `use()` with the auto prompt queued, then the
   * queue kicked so the auto prompt is turn 1. The page-side opener (`<flowpad-agent>`); the app's
   * launcher adds its vibe layer on top (`prepareAgentSession`).
   */
  async newChat(projectId: string): Promise<AgenticProcess> {
    const { process_id } = await this.use(projectId, true);
    const proc = await dataManager.getByTypeId<AgenticProcess>(new TypeId('agentic_process', process_id));
    if (!proc) throw new Error(`the new chat ${process_id} could not be read`);
    await proc.drainQueue().catch((e: unknown) => console.warn('[agent] auto prompt not started', e));
    return proc;
  }

  /** The last chat with this agent in `projectId`, else a new one. */
  async openChat(projectId: string): Promise<AgenticProcess> {
    return (await this.lastChat(projectId)) ?? this.newChat(projectId);
  }

  /**
   * Opening the agent again lands on its last chat: re-apply `auto_open` there
   * (`POST /agent/<id>/resume`) — only what is not open yet; the display is not moved.
   */
  async resume(processId: string): Promise<void> {
    await this.post('resume', { process_id: processId });
  }

  /** Every deployment this agent is the main agent of — the places it answers. */
  async deployments(): Promise<Deployment[]> {
    return Deployment.forMainAgent(this.id);
  }

  /**
   * "Deploy this agent": its project's Deployments page with a new deployment's main agent preset to it.
   * Null for an agent that has no project (it has to move into one first).
   */
  get deployPagePointer(): DockPointerData | null {
    return this.project_id ? Deployment.projectPagePointerFor(this.project_id, null, this.id) : null;
  }

  /**
   * Open a chat on one exact cloud Deployment of this Agent.
   *
   * The Hub validates that the placement belongs to this Agent and creates the
   * real AgenticProcess on that machine. The returned process id is addressed
   * through the ordinary AgenticProcess SDK; callers do not need a second
   * remote-chat transport. `autoPrompt` as in `use` — honoured only for a
   * placement on this machine.
   */
  async useDeployment(deploymentId: string, autoPrompt = false): Promise<AgentUseResult> {
    return (await this.post('use', {
      deployment_id: deploymentId,
      ...autoPromptBody(autoPrompt),
      ...launchSurfaceField(),
    })) as AgentUseResult;
  }

  /**
   * Public deployments: visitors open `/open-pc/<id>` (with an invite code in `code` mode) and get a sandbox of
   * their own. Hub-owned and owner-only, so every call is reflected to the hub.
   */
  async enablePublicDeployments(setup: PublicDeploymentSetup): Promise<PublicDeploymentSettings> {
    return this.publicDeploymentsCall('enable_public_deployments', 'POST', { ...setup });
  }

  async disablePublicDeployments(): Promise<PublicDeploymentSettings> {
    return this.publicDeploymentsCall('disable_public_deployments', 'POST', {});
  }

  /** Settings, codes and boxes; each list defaults to empty (an unpublished agent is answered by the desktop). */
  async publicDeployments(): Promise<PublicDeploymentsState> {
    const data =
      (await this.publicDeploymentsCall<Partial<PublicDeploymentsState> | null>('public_deployments', 'GET')) ?? {};
    return {
      settings: data.settings ?? null,
      codes: Array.isArray(data.codes) ? data.codes : [],
      deployments: Array.isArray(data.deployments) ? data.deployments : [],
    };
  }

  /** Mint `count` (1..100) codes; their plaintext is answered this once only. */
  async addPublicCodes(count: number): Promise<NewPublicInviteCode[]> {
    const data = await this.publicDeploymentsCall<{ codes?: NewPublicInviteCode[] }>('add_public_codes', 'POST', {
      count,
    });
    return data?.codes ?? [];
  }

  /** Revoke a code: its sandbox is deleted and it stops working. */
  async revokePublicCode(codeId: string): Promise<void> {
    await this.publicDeploymentsCall('revoke_public_code', 'POST', { code_id: codeId });
  }

  /** `reset` gives the same deployment a brand-new machine, filled from scratch; it answers like `open`. */
  async managePublicDeployment(nodeTypeId: string, op: PublicDeploymentOp): Promise<PublicDeploymentOpResult> {
    return this.publicDeploymentsCall('manage_public_deployment', 'POST', { node_typeid: nodeTypeId, op });
  }

  /**
   * IT message: run `text` once on each targeted public machine, in a throwaway session; the answers come back as
   * one IT conversation in the StreamInbox. Hub-only and owner-only.
   */
  async itMessage(request: ItMessageRequest): Promise<ItMessageResult> {
    const data = await this.publicDeploymentsCall<Partial<ItMessageResult> | null>('it_message', 'POST', {
      ...request,
    });
    return { conversation_id: data?.conversation_id ?? '', targets: Array.isArray(data?.targets) ? data.targets : [] };
  }

  /**
   * "Turn on and run": ask these machines the IT conversation's own first request again -- its text, files and answer
   * shape -- posting nothing new in the thread.
   */
  async itRerun(conversationId: string, targets: ItTargets): Promise<ItMessageResult> {
    const data = await this.publicDeploymentsCall<Partial<ItMessageResult> | null>('it_message', 'POST', {
      rerun: true,
      conversation_id: conversationId,
      targets,
    });
    return { conversation_id: data?.conversation_id ?? '', targets: Array.isArray(data?.targets) ? data.targets : [] };
  }

  /** Turn IT Sessions on or off on the targeted public machines; answers each machine's resulting state. */
  async setItSessions(targets: ItTargets, on: boolean): Promise<ItSessionsBox[]> {
    const data = await this.publicDeploymentsCall<{ boxes?: ItSessionsBox[] } | null>('it_sessions', 'POST', {
      targets,
      on,
    });
    return Array.isArray(data?.boxes) ? data.boxes : [];
  }

  private publicDeploymentsCall<T>(name: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<T> {
    const info = new ActionInfo(name, this.getType(), this.id, method);
    info.hubReflect = true;
    if (body) info.bodyParameters = body;
    return dataManager.callAction<unknown, T>(info);
  }

  /**
   * What this agent is wired to (`agent/<id>/channels`): its placements and their machines, the caller's links
   * that deliver to them (channel, state, who — never a code or token) and the connections each may use.
   */
  async channels(): Promise<AgentChannels> {
    const info = new ActionInfo('channels', this.getType(), this.id, 'GET');
    info.hubReflect = true;
    // Only the hub knows this; an agent that was never published is answered by the desktop,
    // which has no `channels` action and returns the agent row. Each list defaults to empty.
    const data = (await dataManager.callAction<unknown, Partial<AgentChannels>>(info)) ?? {};
    const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);
    return {
      deployments: list(data.deployments),
      people: list(data.people),
      webhooks: list(data.webhooks),
      connections: list(data.connections),
    };
  }

  /** The Flowpad Assistant's skills this agent may pick from for `assistant_skills`. */
  async assistantSkillCatalog(): Promise<AssistantSkillChoice[]> {
    return (await this.get<AssistantSkillChoice[] | null>('assistant_skill_catalog')) ?? [];
  }

  /** Whether this agent already auto-launched in its project (the once-only mark is set). */
  async autoLaunchState(): Promise<AgentAutoLaunchState> {
    return this.get<AgentAutoLaunchState>('auto_launch_state');
  }

  /** Clear the once-only mark, so the project's next open auto-launches this agent again. */
  async resetAutoLaunch(): Promise<void> {
    await this.post<void>('reset_auto_launch');
  }

  /** Published commit and the changes on this computer that aren't published. */
  async versionState(): Promise<AgentVersionState> {
    return this.get<AgentVersionState>('version');
  }

  /** Fire one of this agent's schedules on a CLOUD place, through the hub (`run_now`). */
  async placeAction(deploymentId: string, op: 'run_now', triggerId: string): Promise<Record<string, unknown>> {
    return ((await this.post('place_action', { deployment_id: deploymentId, op, trigger_id: triggerId })) ??
      {}) as Record<string, unknown>;
  }

  /** Commit, push and register this agent on the hub. `force` republishes an agent already there. */
  async publish(
    options: { force?: boolean } = {},
  ): Promise<{ agent_id: string; published: boolean; already_on_hub: boolean }> {
    return this.post('publish', { force: !!options.force });
  }

  /**
   * The Agent's mailbox and the local source polling it.
   *
   * An Agent HOLDS a mailbox; it is not one. These five are the whole of the
   * Agent's mail surface — everything else about a mailbox (its allowlist, its
   * lifecycle) belongs to `AgentMailbox`, which this hydrates.
   */
  /** Move this project-less agent into a project (`Agent.move_to_project`). */
  async moveToProject(projectId: string): Promise<void> {
    await this.post('move_to_project', { project_id: projectId });
    this.project_id = projectId;
  }

  async mailboxState(): Promise<AgentMailboxState> {
    if (this.mailboxOnHub) {
      const data = await this.hubMailbox<{ mailbox?: HubMailboxDescriptor | null; offered?: boolean }>('', 'GET');
      return { ...this.hubMailboxState(data?.mailbox ?? null), offered: data?.offered ?? true };
    }
    return normalizeAgentMailboxState(await this.get<AgentMailboxStateWire>('mailbox_state'));
  }

  /**
   * Allocate the mailbox, or adopt the one this Agent already has.
   *
   * The single door, and idempotent: an address is billable and permanent, so
   * asking twice never buys twice. It also wires the local source and turns both
   * on — there is no separate "enable".
   */
  async allocateMailbox(options: MailboxAllocation = {}): Promise<AgentMailboxState> {
    // The hub page has no local source to wire: `enable` provisions when absent and reactivates when disabled.
    if (this.mailboxOnHub)
      return this.hubMailboxState(await this.hubMailbox<HubMailboxDescriptor>('enable', 'POST', options));
    return normalizeAgentMailboxState(await this.post<AgentMailboxStateWire>('allocate_mailbox', { ...options }));
  }

  /** Pause the mailbox. Reversible — the address and the cursor survive. */
  async disableMailbox(): Promise<AgentMailboxState> {
    return normalizeAgentMailboxState(await this.post<AgentMailboxStateWire>('disable_mailbox'));
  }

  async configureMailbox(options: MailboxConfiguration): Promise<AgentMailboxState> {
    if (this.mailboxOnHub) {
      const { poll_interval_seconds: _local, ...policy } = options; // the poll cadence is a desktop fact
      return this.hubMailboxState(await this.hubMailbox<HubMailboxDescriptor>('configure', 'POST', policy));
    }
    return normalizeAgentMailboxState(await this.post<AgentMailboxStateWire>('configure_mailbox', { ...options }));
  }

  /** Release the address for good. Distinct from disabling, on purpose. */
  async releaseMailbox(): Promise<{ agent_id: string; released: boolean }> {
    return this.post<{ agent_id: string; released: boolean }>('release_mailbox');
  }

  /** The hub's own `agent/<id>/mailbox[/<verb>]` door — the hub page's transport. */
  private hubMailbox<T>(verb: string, method: 'GET' | 'POST', body?: object): Promise<T> {
    const info = new ActionInfo(verb ? `mailbox/${verb}` : 'mailbox', 'agent', String(this.id), method);
    if (body) info.bodyParameters = body as Record<string, unknown>;
    info.hubReflect = true; // the hub's mailbox: through a desktop it is forwarded, never answered there
    return dataManager.callAction<unknown, T>(info);
  }

  /** A hub descriptor as an `AgentMailboxState` — no local source on the hub page. */
  private hubMailboxState(mailbox: HubMailboxDescriptor | null): AgentMailboxState {
    return normalizeAgentMailboxState({
      agent_id: String(this.id),
      enabled: mailbox?.status === 'active',
      mailbox: mailbox
        ? { ...mailbox, agent_typeid: mailbox.agent_typeid ?? new TypeId(Agent.type, String(this.id)) }
        : null,
      source: null,
      sources: [],
    });
  }

  /** What this agent is told about its built-in email — added to its instructions by Flowpad, read-only. */
  async channelsBlock(): Promise<string> {
    return (await this.get<{ text?: string }>('channels_block'))?.text ?? '';
  }

  async streamInboxScope(): Promise<AgentStreamInboxScope> {
    return this.get<AgentStreamInboxScope>('stream_inbox_scope');
  }
}

export interface MailboxConfiguration {
  /** Receiving: who may drive the agent through this mailbox. Empty admits nobody. Hub-stored. */
  allowed_senders?: string[];
  blocked_senders?: string[];
  /** Sending: who the agent may write to; the Hub refuses anyone else. Hub-stored. */
  allowed_recipients?: string[];
  blocked_recipients?: string[];
  /** "Open to all", per direction. */
  open_senders?: boolean;
  open_recipients?: boolean;
  /** Standing read defaults, in the Hub's wire vocabulary. Hub-stored. */
  filters?: Record<string, string>;
  /** How often THIS machine polls. Local — not a fact about the mailbox. */
  poll_interval_seconds?: number;
}

export interface MailboxAllocation {
  allowed_senders?: string[];
  display_name?: string;
  username?: string;
}

/** What the hub's `mailbox` door answers (`AgentMailbox.descriptor()`). */
export type HubMailboxDescriptor = Omit<Partial<IAgentMailbox>, 'agent_typeid'> & {
  typeid?: string;
  agent_typeid?: TypeId | string;
};

interface AgentMailboxStateWire {
  agent_id: string;
  enabled: boolean;
  mailbox: (Omit<Partial<IAgentMailbox>, 'agent_typeid'> & { typeid?: string; agent_typeid: TypeId | string }) | null;
  source: (Partial<IDataSource> & { id?: string; typeid?: string }) | null;
  /** Every message source the agent owns; the mailbox is one of them. */
  sources?: (Partial<IDataSource> & { id?: string; typeid?: string })[];
  offered?: boolean;
}

export interface AgentMailboxState {
  agent_id: string;
  enabled: boolean;
  /** The mailbox channel's own row and source — kept for readers that predate
   *  an agent holding more than one channel. */
  mailbox: AgentMailbox | null;
  source: DataSource | null;
  /** Every message source the agent owns (the mailbox included). */
  sources: DataSource[];
  /** Whether this hub can give an agent its built-in email at all; absent = not known, assume yes. */
  offered?: boolean;
}

export interface AgentStreamInboxScope {
  agent_id: string;
  source_id: string | null;
  conversation_ids: string[];
  thread_ids: string[];
  flow_message_ids: string[];
}

function entityId(value: { id?: string; typeid?: string } | null): string | undefined {
  if (!value) return undefined;
  return value.id ?? (value.typeid ? new TypeId(value.typeid).id : undefined);
}

function normalizeAgentMailboxState(state: AgentMailboxStateWire): AgentMailboxState {
  const mailboxId = entityId(state.mailbox);
  const sourceId = entityId(state.source);
  return {
    agent_id: state.agent_id,
    enabled: state.enabled,
    offered: state.offered ?? true,
    mailbox:
      state.mailbox && mailboxId
        ? new AgentMailbox({
            ...state.mailbox,
            id: mailboxId,
            agent_typeid:
              typeof state.mailbox.agent_typeid === 'string'
                ? new TypeId(state.mailbox.agent_typeid)
                : state.mailbox.agent_typeid,
          })
        : null,
    source: state.source && sourceId ? new DataSource({ ...state.source, id: sourceId }) : null,
    sources: (state.sources ?? []).flatMap((row) => {
      const id = entityId(row);
      return id ? [new DataSource({ ...row, id })] : [];
    }),
  };
}

/**
 * What `POST /agent/<id>/deploy` hands back.
 *
 * `deployment` is the placement ROW — the same entity, at the same id, that the
 * local backend has already adopted by the time this resolves. Callers render
 * the persisted Deployment rather than this response: it is a receipt, not the
 * state.
 */
export interface AgentDeployResult {
  agent_id: string;
  deployment?: IDeployment;
  node_typeid?: string;
  host_url?: string;
  /**
   * A cloud deploy taken on: it runs on, reporting at this activity, until its machine is placed.
   * Absent on this computer's deploy, whose answer is already the outcome.
   */
  activity?: Pick<ActivityProgressSpec, 'path' | 'subject_entity'>;
  /** The placement a taken-on deploy lands on, before its machine exists. */
  deployment_id?: string;
}

/** What `POST /agent/<id>/use` hands back — the session opened as the agent.
 *  Not a call answer: opening a session runs nothing, so it names the process. */
export interface AgentUseResult {
  process_id: string;
  process_typeid: string;
  deployment_id: string;
}

/** The body key for an opted-in `use` — absent unless asked, so the hub relay
 *  and SDK callers that never drain keep a turn-less session. */
function autoPromptBody(autoPrompt: boolean): { auto_prompt?: true } {
  return autoPrompt ? { auto_prompt: true } : {};
}

/** The fields a schedule manages — `POST /agent/<id>/add_schedule` and friends
 *  (`flow_sdk/builtin/agent_schedule.py`). Omitted fields are left as they are. */
export interface AgentScheduleFields {
  name?: string;
  description?: string;
  /** How `expr` is read: a crontab, an interval (`30s`/`5m`), or an ISO date. */
  every?: 'cron' | 'interval' | 'date';
  expr?: string;
  /** IANA zone, e.g. `Asia/Jerusalem`. Empty = the backend machine's zone. */
  timezone?: string;
  /** The place (Deployment id) the schedule runs on. Empty = every machine (legacy). */
  runs_on?: string;
  prompt?: string;
  enabled?: boolean;
}

/** The launch settings a place may override — `PLACE_OVERRIDABLE_FIELDS` in agent_spec.py. */
/** `PhoneNumberSpec` — digits only; the backend strips `+`, separators and one trunk `0`. */
export interface PhoneNumberWire {
  country_code: string;
  number: string;
}

/** `agent/<id>/channels`: what an agent is wired to, names and states only. */
export interface AgentChannels {
  deployments: {
    typeid: string;
    node_typeid: string | null;
    agent_mode?: 'shared' | 'private';
    channels?: string[];
    idle_pause_seconds?: number | null;
    template_deployment_id?: string | null;
  }[];
  /** A private deployment's people (its owner reads them): each person's own placement, its state and its cap. */
  people?: AgentPerson[];
  /** The caller's links delivering to this agent: the channel (`slack`, `whatsapp`…), its state, who it reaches. */
  webhooks: { id: string; provider: string; status: string; sender: string; name: string; deployment_typeid: string }[];
  /** Connections a placement may use (`deployment/<id>/authorize`). */
  connections: { provider: string; deployment_typeid: string }[];
}

/** One person of a private deployment, as `agent/<id>/channels` answers it. */
export interface AgentPerson {
  deployment_typeid: string;
  template_deployment_id: string;
  /** The project the agent's deployments belong to (their pages live in its Deployments). */
  project_id: string | null;
  person_key: string;
  /** The person as the provider knows them: an email, a Slack sender, an API caller. */
  who: string;
  /** The machine's state: running, paused, not_started, … */
  state: string;
  cap_usd_per_day: number | null;
  allocation_typeid: string | null;
}

/** `GET /agent/<id>/version` — what this computer has that the published version lacks. */
export interface AgentVersionState {
  published: boolean;
  published_commit: string;
  has_repo: boolean;
  pending_changes: number;
  /** The project is a git checkout: its commits are what deploys, so `uncommitted`/`unpushed` block a deploy. */
  git_native?: boolean;
  /** That checkout has a remote of its own (then `unpushed` counts commits no remote holds). */
  has_remote?: boolean;
  uncommitted?: number;
  unpushed?: number;
}
