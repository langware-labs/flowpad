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
 *  (the same shape `CapabilityManager` uses), rather than reading raw JSON.
 *
 *  Returns null when the name matches nothing. Callers MUST treat that as fatal
 *  — see `startWizardProcess`. */
export async function resolveWizardAgentRef(name: string): Promise<string | null> {
  if (name in wizardAgentRefCache) return wizardAgentRefCache[name];
  const rows = await apiClient.get<unknown[]>('/graph/agent', { params: { include_system: true } });
  const agents = (rows ?? []).map((row) => dataManager.updateEntityFromJson<SubAgent>(row));
  const ref = agents.find((a) => a.name === name)?.asset_ref ?? null;
  wizardAgentRefCache = { ...wizardAgentRefCache, [name]: ref };
  return ref;
}

/** Forget the cached name→ref answers. The resolver caches misses as well as
 *  hits, so a wizard indexed after a failed lookup would stay unresolvable for
 *  the life of the page without this. */
export function clearWizardAgentRefCache(): void {
  wizardAgentRefCache = {};
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

  // Resolved BEFORE the process exists, and fatal when it misses.
  //
  // This used to sit after createProcess and merely `console.warn`, so a
  // mistyped or unindexed wizard name produced a REAL process running the
  // wizard prompt with no agent embedded: it answered as a generic assistant,
  // never ran `flow wizard … close`, and the caller's promise hung forever with
  // a warning buried in the console. A name that resolves to nothing is a bug in
  // the caller, and the only useful thing to do with it is say so loudly before
  // anything is spawned.
  const agentRef = await resolveWizardAgentRef(request.wizardName);
  if (!agentRef) {
    // The cache stores misses too; drop it so a wizard indexed after this
    // failure is resolvable on the next attempt.
    clearWizardAgentRefCache();
    throw new Error(
      `No wizard named "${request.wizardName}" is installed. ` +
      'Wizards are agents under agentic-assets/agent/ or .claude/agents/; ' +
      'check the name, or re-index if it was just added.',
    );
  }

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
  // `agentRef` was resolved above, so a failure here is a real embed failure
  // (a deleted asset, a backend error) rather than an unknown name.
  await process.loadEmbeddedSubagent(agentRef);

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
