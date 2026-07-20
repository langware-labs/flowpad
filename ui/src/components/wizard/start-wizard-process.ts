import {
  Agent,
  AgenticProcess,
  ComputeNode,
  ProcessKind,
  apiClient,
  awaitWizardResult,
  buildWizardPrompt,
  dataManager,
  type WizardLaunchRequest,
  type WizardProcessResult,
} from '@sdk';

let wizardAgentRefCache: Record<string, string | null> = {};

/** Resolve a wizard's agent by name → its `asset_ref` (the wizard name IS the
 *  agent name; there is no static table). Cached per name.
 *
 *  System (SDK-shipped) wizard agents only surface with `include_system`, which
 *  the entity query layer omits — so we hit the graph route with the flag passed
 *  as `params` and hydrate the rows into `Agent` entities via `dataManager`
 *  (the same shape `CapabilityManager` uses), rather than reading raw JSON. */
export async function resolveWizardAgentRef(name: string): Promise<string | null> {
  if (name in wizardAgentRefCache) return wizardAgentRefCache[name];
  const rows = await apiClient.get<unknown[]>('/graph/agent', { params: { include_system: true } });
  const agents = (rows ?? []).map((row) => dataManager.updateEntityFromJson<Agent>(row));
  const ref = agents.find((a) => a.name === name)?.asset_ref ?? null;
  wizardAgentRefCache = { ...wizardAgentRefCache, [name]: ref };
  return ref;
}

export interface StartedWizard<T = unknown> {
  process: AgenticProcess;
  /** The `target_typeid_str` a modal viewer (EntityExecutionPanel) attaches to. */
  target: string;
  /** Resolves when the agent runs `flow wizard <id> close` (via `wizard.closed`)
   *  or the initial prompt fails. */
  result: Promise<WizardProcessResult<T>>;
}

/**
 * Create a headless `ProcessKind.Wizard` process, embed the same-named agent,
 * and fire the initial prompt.
 *
 * This is the shared engine behind BOTH the modal `WizardHost` (double-click)
 * and the inline `useWizardRun` button (single-click headless). The process is
 * always headless (`visible:false`); whether a modal viewer mounts on it is the
 * caller's choice — that's the only difference between the two paths.
 */
export async function startWizardProcess<T = unknown>(request: WizardLaunchRequest): Promise<StartedWizard<T>> {
  const computeNode = await ComputeNode.getById('@local');
  if (!computeNode) throw new Error('No local compute node');

  const target = `wizard:${request.wizardName}:${Date.now()}`;
  const process = await computeNode.createProcess(
    {
      targetVfsPath: target,
      processType: ProcessKind.Wizard,
      outputFormat: 'stream-json',
      loadFlowpadAssistant: true,
      contextData: {
        wizard: {
          name: request.wizardName,
          data: request.wizardData ?? null,
        },
      },
    },
    { visible: false, pty_mode: false },
  );

  const initialPrompt = buildWizardPrompt(process.id, request);
  // Subscribe for the close event BEFORE embedding/prompting so we can't miss it.
  const wizardClosed = awaitWizardResult<T>(process);

  // Embed the driving agent before the prompt so it handles the turn.
  try {
    const agentRef = await resolveWizardAgentRef(request.wizardName);
    if (agentRef) await process.loadEmbeddedAgent(agentRef);
  } catch (e) {
    console.warn(`[startWizardProcess] failed to embed wizard agent ${request.wizardName}`, e);
  }

  // A prompt-level failure never fires `wizard.closed`, so race it in as an
  // error result rather than leaving `result` pending forever.
  const result = Promise.race<WizardProcessResult<T>>([
    wizardClosed,
    new Promise<WizardProcessResult<T>>((resolve) => {
      void process.prompt(initialPrompt).catch((err) => {
        resolve({ status: 'error', data: null, errorStr: err instanceof Error ? err.message : String(err) });
      });
    }),
  ]);

  return { process, target, result };
}
