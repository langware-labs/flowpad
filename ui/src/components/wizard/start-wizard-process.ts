import {
  SubAgent,
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
 *  as `params` and hydrate the rows into `SubAgent` entities via `dataManager`
 *  (the same shape `CapabilityManager` uses), rather than reading raw JSON. */
export async function resolveWizardAgentRef(name: string): Promise<string | null> {
  if (name in wizardAgentRefCache) return wizardAgentRefCache[name];
  const rows = await apiClient.get<unknown[]>('/graph/agent', { params: { include_system: true } });
  const agents = (rows ?? []).map((row) => dataManager.updateEntityFromJson<SubAgent>(row));
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
export async function startWizardProcess<T = unknown>(
  request: WizardLaunchRequest,
  opts?: { headless?: boolean },
): Promise<StartedWizard<T>> {
  const headless = opts?.headless ?? false;
  const computeNode = await ComputeNode.getById('@local');
  if (!computeNode) throw new Error('No local compute node');

  // Prefer a STABLE target (the subject entity's TypeId) so the run is
  // reconnectable via useProcessesForTarget regardless of whether the agent got
  // around to stamping process_id. Fall back to a unique key when no subject.
  const target = request.wizardData?.targetTypeId?.trim() || `wizard:${request.wizardName}:${Date.now()}`;
  const process = await computeNode.createProcess(
    {
      targetVfsPath: target,
      processType: ProcessKind.Wizard,
      outputFormat: 'stream-json',
      loadFlowpadAssistant: true,
      // A wizard may pin its model tier; the backend resolves `sm`/`md`/`lg` per
      // worker into the concrete `--model` flag. Undefined leaves the default.
      model: request.wizardData?.model,
      contextData: {
        wizard: {
          name: request.wizardName,
          data: request.wizardData ?? null,
        },
      },
    },
    { visible: false, pty_mode: false },
  );

  const initialPrompt = buildWizardPrompt(process.id, request, { headless });
  // Subscribe for the close event BEFORE embedding/prompting so we can't miss it.
  const wizardClosed = awaitWizardResult<T>(process);

  // Embed the driving sub-agent before the prompt so it handles the turn.
  try {
    const agentRef = await resolveWizardAgentRef(request.wizardName);
    if (agentRef) await process.loadEmbeddedSubagent(agentRef);
  } catch (e) {
    console.warn(`[startWizardProcess] failed to embed wizard sub-agent ${request.wizardName}`, e);
  }

  // `result` resolves on the FIRST of:
  //  - `wizard.closed` — the agent closed with its verdict (preferred; carries data);
  //  - prompt error — the turn failed;
  //  - (headless only) the prompt RESOLVING — the agent's turn ended cleanly.
  // The last one is the safety net: a headless run must not hang forever just
  // because the agent finished without closing the wizard (worker_status goes
  // `complete`, but no `wizard.closed` ever arrives). Modal runs deliberately
  // omit it — there the user closes via Done, so a bare turn-end must NOT end
  // the wizard.
  const result = new Promise<WizardProcessResult<T>>((resolve) => {
    void wizardClosed.then(resolve);
    void process
      .prompt(initialPrompt)
      .then(() => {
        if (headless) resolve({ status: 'done', data: null });
      })
      .catch((err) => {
        resolve({ status: 'error', data: null, errorStr: err instanceof Error ? err.message : String(err) });
      });
  });

  return { process, target, result };
}
